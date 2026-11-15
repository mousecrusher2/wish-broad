// LiveState Durable Object。オブジェクトは自身のストレージとアラーム以外を await せず、
// 外部 API は Worker と LiveEffects（../live/effects）が呼び出す。理由は docs/architecture.md の
// 「ランタイムモデル」を参照。
import { DurableObject } from "cloudflare:workers";
import * as v from "valibot";
import type { LiveSummary, User } from "../../shared/protocol";
import { createErrorLogFields, logInfo, logWarn } from "../lib/logger";
import type {
  LiveRecord,
  NotificationDeleteJob,
  StoredTrack,
} from "../live/types";
import type { Bindings } from "../types";
import { migrateSchema } from "./migrations";

/**
 * すべての状態を保持する唯一のオブジェクトの名前。1 つにまとめている理由は
 * docs/architecture.md の「ランタイムモデル」を参照。
 */
const LIVE_STATE_NAME = "global";

type LiveEndReason = "reconnect_grace_expired" | "session_inactive";

/** 行が削除された直後の配信。 */
type EndedLive = {
  /** 開始通知の Discord snowflake（10 進数文字列）。 */
  notificationMessageId: string | null;
  sessionId: string;
  userId: string;
};

/** コマンドが実行中のトランザクションから受け取るコンテキスト。 */
type CommandRun = {
  /**
   * トランザクションのコミット後に Worker へ引き渡す開始通知の削除を追加する。
   * ロールバックされたコマンドの削除は引き渡さない。
   */
  deleteNotificationOnCommit(job: NotificationDeleteJob): void;
  /**
   * トランザクションのコミット後に書き出すログエントリをキューに追加する。
   * ロールバックされたコマンドは何も報告しないため、保存されなかった変更についてのログは出力されない。
   */
  logOnCommit(write: () => void): void;
  now: number;
  sql: SqlStorage;
};

// 呼び出し元から受け取って保存する値は、書き込み時にも読み取りと同じスキーマで検証して保存前に
// 拒否する。読み戻せない値が 1 つでも保存されると、通知 ID と時刻なら期限切れの配信の終了や
// 次のアラームの計算を行うすべてのメソッドが、トラックならその配信者の getLive が以降ずっと失敗するため。

/** 10 進数文字列として表現された Discord snowflake。 */
function createNotificationMessageIdSchema() {
  return v.pipe(v.string(), v.regex(/^[0-9]+$/u));
}

let notificationMessageIdSchema:
  ReturnType<typeof createNotificationMessageIdSchema> | undefined;

function getNotificationMessageIdSchema() {
  notificationMessageIdSchema ??= createNotificationMessageIdSchema();

  return notificationMessageIdSchema;
}

/** Unix エポックミリ秒。 */
function createTimestampSchema() {
  return v.pipe(v.number(), v.integer());
}

let timestampSchema: ReturnType<typeof createTimestampSchema> | undefined;

function getTimestampSchema() {
  timestampSchema ??= createTimestampSchema();

  return timestampSchema;
}

function createStoredTrackSchema() {
  return v.object({
    location: v.literal("remote"),
    sessionId: v.string(),
    trackName: v.string(),
    mid: v.string(),
  });
}

let storedTrackSchema: ReturnType<typeof createStoredTrackSchema> | undefined;

function getStoredTrackSchema() {
  storedTrackSchema ??= createStoredTrackSchema();

  return storedTrackSchema;
}

function createStoredTracksSchema() {
  return v.array(getStoredTrackSchema());
}

let storedTracksSchema: ReturnType<typeof createStoredTracksSchema> | undefined;

function getStoredTracksSchema() {
  storedTracksSchema ??= createStoredTracksSchema();

  return storedTracksSchema;
}

/** @throws {Error} `value` が 10 進数文字列の Discord snowflake でない場合。 */
function assertNotificationMessageId(value: string, column: string): void {
  if (!v.is(getNotificationMessageIdSchema(), value)) {
    throw new Error(`Invalid ${column}`);
  }
}

/** @throws {Error} `value` が整数でない場合。 */
function assertTimestamp(value: number, column: string): void {
  if (!v.is(getTimestampSchema(), value)) {
    throw new Error(`Invalid ${column}`);
  }
}

/** @throws {Error} `tracks` が getLive で読み戻せない形式の場合。 */
function assertStoredTracks(tracks: StoredTrack[]): void {
  if (!v.is(getStoredTracksSchema(), tracks)) {
    throw new Error("Invalid lives.tracks_json");
  }
}

function createLiveRowSchema() {
  return v.object({
    broadcast_id: v.string(),
    grace_expires_at: v.nullable(getTimestampSchema()),
    session_seen_active_at: v.nullable(getTimestampSchema()),
    user_id: v.string(),
    session_id: v.string(),
    tracks_json: v.string(),
  });
}

let liveRowSchema: ReturnType<typeof createLiveRowSchema> | undefined;

function getLiveRowSchema() {
  liveRowSchema ??= createLiveRowSchema();

  return liveRowSchema;
}

function createLiveTokenRowSchema() {
  return v.object({
    token_hash: v.string(),
  });
}

let liveTokenRowSchema: ReturnType<typeof createLiveTokenRowSchema> | undefined;

function getLiveTokenRowSchema() {
  liveTokenRowSchema ??= createLiveTokenRowSchema();

  return liveTokenRowSchema;
}

function createLiveListRowSchema() {
  return v.object({
    user_id: v.string(),
    display_name: v.string(),
  });
}

let liveListRowSchema: ReturnType<typeof createLiveListRowSchema> | undefined;

function getLiveListRowSchema() {
  liveListRowSchema ??= createLiveListRowSchema();

  return liveListRowSchema;
}

function createEndedLiveRowSchema() {
  return v.object({
    notification_message_id: v.nullable(getNotificationMessageIdSchema()),
    session_id: v.string(),
    user_id: v.string(),
  });
}

let endedLiveRowSchema: ReturnType<typeof createEndedLiveRowSchema> | undefined;

function getEndedLiveRowSchema() {
  endedLiveRowSchema ??= createEndedLiveRowSchema();

  return endedLiveRowSchema;
}

function createNextWakeRowSchema() {
  return v.object({
    wake_at: v.nullable(getTimestampSchema()),
  });
}

let nextWakeRowSchema: ReturnType<typeof createNextWakeRowSchema> | undefined;

function getNextWakeRowSchema() {
  nextWakeRowSchema ??= createNextWakeRowSchema();

  return nextWakeRowSchema;
}

/** @throws {Error} 行の形式がこのオブジェクトの書き込む形式と一致しない場合。 */
function parseEndedLiveRow(row: unknown): EndedLive {
  const rowResult = v.safeParse(getEndedLiveRowSchema(), row);
  if (!rowResult.success) {
    throw new Error("Invalid ended lives row");
  }

  return {
    notificationMessageId: rowResult.output.notification_message_id,
    sessionId: rowResult.output.session_id,
    userId: rowResult.output.user_id,
  };
}

/** すべてのライブ状態を保持する LiveState オブジェクトのスタブを返す。 */
export function getLiveState(env: Pick<Bindings, "LIVE_STATE">) {
  return env.LIVE_STATE.getByName(LIVE_STATE_NAME);
}

/**
 * ライブ配信、配信者トークン、およびユーザーを保持し、再接続猶予期間の経過後に
 * 配信を終了させる Durable Object。
 *
 * すべてのメソッドは 1 つのトランザクションで実行され、最初に期限切れの配信を終了させる。
 * Worker が SFU で観測した結果に基づく状態遷移は、Worker が観測したセッションに対する
 * Compare-And-Set になっている（docs/architecture.md「配信行のセマンティクス」）。
 * 保存されている行がこのオブジェクトの書き込む形式と一致しなければ、その行を読んだメソッドは
 * reject する。reject したメソッドは何も保存していない。メソッドがスローしたエラーは RPC を
 * 越えるとクラスが失われ、同じメッセージの `Error` として呼び出し元に届く。
 */
export class LiveState extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      migrateSchema(ctx.storage.sql);
    });
  }

  /** 猶予期間の終了時に実行され、期限切れの配信を終了させる。 */
  override async alarm(): Promise<void> {
    await this.#run(() => undefined);
  }

  async getLive(userId: string): Promise<LiveRecord | null> {
    return this.#run(({ sql }) => {
      const [result] = sql
        .exec(
          "SELECT user_id, broadcast_id, session_id, tracks_json, grace_expires_at, session_seen_active_at FROM lives WHERE user_id = ?",
          userId,
        )
        .toArray();
      if (result === undefined) {
        return null;
      }

      const rowResult = v.safeParse(getLiveRowSchema(), result);
      if (!rowResult.success) {
        throw new Error("Invalid lives row");
      }
      const row = rowResult.output;

      const parsedTracksInput: unknown = JSON.parse(row.tracks_json);
      const tracksResult = v.safeParse(
        getStoredTracksSchema(),
        parsedTracksInput,
      );
      if (!tracksResult.success) {
        throw new Error("Invalid lives.tracks_json");
      }

      return {
        broadcastId: row.broadcast_id,
        graceExpiresAt: row.grace_expires_at,
        sessionSeenActiveAt: row.session_seen_active_at,
        userId: row.user_id,
        sessionId: row.session_id,
        tracks: tracksResult.output,
      };
    });
  }

  /** 再接続猶予期間中のものも含め、すべての配信の配信者一覧を返す。 */
  async getAllLives(): Promise<LiveSummary[]> {
    return this.#run(({ sql }) =>
      sql
        .exec(
          "SELECT users.user_id, display_name FROM lives JOIN users ON lives.user_id = users.user_id ORDER BY users.user_id",
        )
        .toArray()
        .map((row) => {
          const rowResult = v.safeParse(getLiveListRowSchema(), row);
          if (!rowResult.success) {
            throw new Error("Invalid live list row");
          }

          return {
            owner: {
              userId: rowResult.output.user_id,
              displayName: rowResult.output.display_name,
            },
          };
        }),
    );
  }

  /**
   * 新しい配信を開始してその ID を返す。競合する別のインジェストが先に作成または再開した
   * などの理由で、配信者がすでに配信を持っている場合は null を返す。
   *
   * @throws {Error} `tracks` が getLive で読み戻せない形式の場合。
   */
  async insertLive(
    userId: string,
    sessionId: string,
    tracks: StoredTrack[],
  ): Promise<string | null> {
    return this.#run(({ sql }) => {
      assertStoredTracks(tracks);
      const broadcastId = crypto.randomUUID();
      // ここでは upsert を行わない。競合する 2 つ目のインジェストは既存の live 行を
      // 後続セッションで上書きして再通知するのではなく、フェイルクローズで拒否すべきである。
      // 再接続時は resumeLive で行を再開し、古い行は挿入前に終了される。
      const inserted = sql
        .exec(
          "INSERT INTO lives (user_id, broadcast_id, session_id, tracks_json) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING RETURNING user_id",
          userId,
          broadcastId,
          sessionId,
          JSON.stringify(tracks),
        )
        .toArray();

      return inserted.length > 0 ? broadcastId : null;
    });
  }

  /**
   * 猶予期間中、または前回のセッションが DELETE なしで失われた直後に、`previousSessionId` を
   * 保持している配信を新しいインジェストセッションで継続し、猶予期間を終了させる。配信が
   * すでに終了したか別のインジェストが先に再開していた場合は false を返す。
   *
   * @throws {Error} `tracks` が getLive で読み戻せない形式の場合。
   */
  async resumeLive(
    userId: string,
    previousSessionId: string,
    sessionId: string,
    tracks: StoredTrack[],
  ): Promise<boolean> {
    return this.#run(({ sql }) => {
      assertStoredTracks(tracks);
      const updated = sql
        .exec(
          "UPDATE lives SET session_id = ?, tracks_json = ?, grace_expires_at = NULL, session_seen_active_at = NULL WHERE user_id = ? AND session_id = ? RETURNING user_id",
          sessionId,
          JSON.stringify(tracks),
          userId,
          previousSessionId,
        )
        .toArray();

      return updated.length > 0;
    });
  }

  /**
   * 配信終了前に配信者へ `graceMs` ミリ秒の再接続猶予を与え、同じトランザクション内で
   * 終了用アラームを設定する。行がすでに猶予期間外で `sessionId` を保持していない場合は
   * null を返し、設定できた場合は期限時刻を返す。
   *
   * @throws {Error} `graceMs` が整数でない場合。
   */
  async startLiveReconnectGrace(
    userId: string,
    sessionId: string,
    graceMs: number,
  ): Promise<number | null> {
    return this.#run(({ now, sql }) => {
      const graceExpiresAt = now + graceMs;
      assertTimestamp(graceExpiresAt, "lives.grace_expires_at");
      const updated = sql
        .exec(
          "UPDATE lives SET grace_expires_at = ? WHERE user_id = ? AND session_id = ? AND grace_expires_at IS NULL RETURNING user_id",
          graceExpiresAt,
          userId,
          sessionId,
        )
        .toArray();

      return updated.length > 0 ? graceExpiresAt : null;
    });
  }

  /**
   * Worker が非アクティブと確認したインジェストセッションの配信を終了させ、
   * 開始通知の削除を Worker に引き渡す。行がすでに猶予期間外で `sessionId` を保持していない
   * 場合は false を返す。
   */
  async endLive(userId: string, sessionId: string): Promise<boolean> {
    return this.#run((run) => {
      const [deleted] = run.sql
        .exec(
          "DELETE FROM lives WHERE user_id = ? AND session_id = ? AND grace_expires_at IS NULL RETURNING user_id, session_id, notification_message_id",
          userId,
          sessionId,
        )
        .toArray();
      if (deleted === undefined) {
        return false;
      }

      this.#finishEndedLive(
        run,
        parseEndedLiveRow(deleted),
        "session_inactive",
      );
      return true;
    });
  }

  /**
   * Worker が SFU 上で配信中インジェストセッションの生存を確認したことを記録する。健全な配信の
   * 同時視聴者全員が毎回行を書き込まないよう、`minIntervalMs` ごとに最大 1 回だけ記録する。
   * 間隔内の記録がすでにあるか、行がそのセッションを保持していない場合は false を返す。
   */
  async markLiveSessionSeenActive(
    userId: string,
    sessionId: string,
    minIntervalMs: number,
  ): Promise<boolean> {
    return this.#run(({ now, sql }) => {
      const updated = sql
        .exec(
          "UPDATE lives SET session_seen_active_at = ? WHERE user_id = ? AND session_id = ? AND (session_seen_active_at IS NULL OR session_seen_active_at <= ?) RETURNING user_id",
          now,
          userId,
          sessionId,
          now - minIntervalMs,
        )
        .toArray();

      return updated.length > 0;
    });
  }

  /**
   * Worker が配信のために送信した開始通知を保存する。その配信がすでに終了している場合は、
   * 代わりにその通知の削除を Worker に引き渡して false を返す。
   *
   * @throws {Error} `messageId` が 10 進数文字列の Discord snowflake でない場合。
   */
  async setLiveNotificationMessageId(
    userId: string,
    broadcastId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.#run((run) => {
      assertNotificationMessageId(messageId, "lives.notification_message_id");
      const updated = run.sql
        .exec(
          "UPDATE lives SET notification_message_id = ? WHERE user_id = ? AND broadcast_id = ? RETURNING user_id",
          messageId,
          userId,
          broadcastId,
        )
        .toArray();
      if (updated.length > 0) {
        return true;
      }

      run.deleteNotificationOnCommit({ messageId, userId });
      return false;
    });
  }

  /** ユーザーの配信者トークンを置き換える。 */
  async setLiveToken(userId: string, tokenHash: string): Promise<void> {
    await this.#run(({ sql }) => {
      sql.exec(
        "INSERT OR REPLACE INTO live_tokens (user_id, token_hash) VALUES (?, ?)",
        userId,
        tokenHash,
      );
    });
  }

  async getLiveTokenHash(userId: string): Promise<string | null> {
    return this.#run(({ sql }) => {
      const [result] = sql
        .exec("SELECT token_hash FROM live_tokens WHERE user_id = ?", userId)
        .toArray();
      if (result === undefined) {
        return null;
      }

      const rowResult = v.safeParse(getLiveTokenRowSchema(), result);
      if (!rowResult.success) {
        throw new Error("Invalid live_tokens row");
      }

      return rowResult.output.token_hash;
    });
  }

  async hasLiveToken(userId: string): Promise<boolean> {
    return this.#run(
      ({ sql }) =>
        sql
          .exec(
            "SELECT 1 AS found FROM live_tokens WHERE user_id = ? LIMIT 1",
            userId,
          )
          .toArray().length > 0,
    );
  }

  async setUser(user: User): Promise<void> {
    await this.#run(({ sql }) => {
      sql.exec(
        "INSERT OR REPLACE INTO users (user_id, display_name) VALUES (?, ?)",
        user.userId,
        user.displayName,
      );
    });
  }

  /**
   * 猶予期間を過ぎた配信を終了させたうえで、1 つのコマンドをストレージトランザクション内で
   * 実行する。同じトランザクション内で次の猶予期限へアラームを移動するため、期限が対応する
   * アラームなしに保存されることはない。クロージャーはアラーム操作以外では一切 await しない。
   * コミット後、終了した配信の開始通知の削除を Worker に引き渡す。
   */
  async #run<T>(command: (run: CommandRun) => T): Promise<T> {
    const { storage } = this.ctx;
    const commitLogs: (() => void)[] = [];
    const notificationDeletes: NotificationDeleteJob[] = [];
    const result = await storage.transaction(async (txn) => {
      try {
        const run: CommandRun = {
          deleteNotificationOnCommit(job) {
            notificationDeletes.push(job);
          },
          logOnCommit(write) {
            commitLogs.push(write);
          },
          now: Date.now(),
          sql: storage.sql,
        };
        this.#endOverdueLives(run);
        const commandResult = command(run);
        await this.#moveAlarm();
        return commandResult;
      } catch (error: unknown) {
        // コマンドやアラーム呼び出しが失敗したときに変更の一部だけが永続化されてはならない。
        txn.rollback();
        throw error;
      }
    });

    // トランザクションがコミットされたため、コマンドの変更内容は確実に保存されている。
    for (const write of commitLogs) {
      write();
    }
    await this.#dispatchNotificationDeletes(notificationDeletes);
    return result;
  }

  /**
   * 開始通知の削除を LiveEffects に引き渡す。LiveEffects は即座に返却して waitUntil 内で
   * 削除するため、このオブジェクトは Discord の応答を待たない。削除はベストエフォートであり、
   * 引き渡しに失敗してもログ出力だけで済ませる。
   */
  async #dispatchNotificationDeletes(
    jobs: NotificationDeleteJob[],
  ): Promise<void> {
    if (jobs.length === 0) {
      return;
    }

    try {
      await this.ctx.exports.LiveEffects.deleteStartNotifications(jobs);
    } catch (error: unknown) {
      logWarn(this.env, "live_notification.delete_dispatch_failed", {
        ...createErrorLogFields(error),
        messageIds: jobs.map((job) => job.messageId),
      });
    }
  }

  /** 再接続猶予期間を過ぎたすべての配信を終了させる。 */
  #endOverdueLives(run: CommandRun): void {
    const deleted = run.sql
      .exec(
        "DELETE FROM lives WHERE grace_expires_at <= ? RETURNING user_id, session_id, notification_message_id",
        run.now,
      )
      .toArray();
    for (const row of deleted) {
      this.#finishEndedLive(
        run,
        parseEndedLiveRow(row),
        "reconnect_grace_expired",
      );
    }
  }

  #finishEndedLive(
    run: CommandRun,
    ended: EndedLive,
    reason: LiveEndReason,
  ): void {
    run.logOnCommit(() => {
      logInfo(this.env, "live.ended", {
        reason,
        sessionId: ended.sessionId,
        userId: ended.userId,
      });
    });
    if (ended.notificationMessageId !== null) {
      run.deleteNotificationOnCommit({
        messageId: ended.notificationMessageId,
        userId: ended.userId,
      });
    }
  }

  /**
   * 次の猶予期限へアラームを移動する。状態を変更した同じトランザクション内で呼び出すこと。
   */
  async #moveAlarm(): Promise<void> {
    const { storage } = this.ctx;
    const wakeResult = v.safeParse(
      getNextWakeRowSchema(),
      storage.sql
        .exec("SELECT MIN(grace_expires_at) AS wake_at FROM lives")
        .toArray()[0],
    );
    if (!wakeResult.success) {
      throw new Error("Invalid next wake row");
    }

    const wakeAt = wakeResult.output.wake_at;
    // アラームハンドラーの実行中に新しいアラームを設定しない限り、この値は null になる
    // （発火中のアラームはすでに設定済みとはみなされない）。
    const scheduledAt = await storage.getAlarm();
    if (wakeAt === scheduledAt) {
      return;
    }

    if (wakeAt === null) {
      await storage.deleteAlarm();
    } else {
      await storage.setAlarm(wakeAt);
    }
  }
}
