// LiveState Durable Object。オブジェクトは自身のストレージとアラーム以外を await せず、
// 外部 API は Worker と LiveEffects（../live/effects）が呼び出す。理由は docs/architecture.md の
// 「ランタイムモデル」を参照。
import { DurableObject } from "cloudflare:workers";
import type { LiveSummary, User } from "../../shared/protocol";
import { createErrorLogFields, logInfo, logWarn } from "../lib/logger";
import type {
  LiveRecord,
  NotificationDeleteJob,
  StoredTrack,
} from "../live/types";
import type { Bindings } from "../types";
import * as db from "./database";

/**
 * すべての状態を保持する唯一のオブジェクトの名前。1 つにまとめている理由は
 * docs/architecture.md の「ランタイムモデル」を参照。
 */
const LIVE_STATE_NAME = "global";

type LiveEndReason = "reconnect_grace_expired" | "session_inactive";

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
};

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
 * reject したメソッドは何も保存していない。メソッドがスローしたエラーは RPC を越えると
 * クラスが失われ、同じメッセージの `Error` として呼び出し元に届く。
 */
export class LiveState extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      db.migrateSchema(ctx.storage.sql);
    });
  }

  /** 猶予期間の終了時に実行され、期限切れの配信を終了させる。 */
  override async alarm(): Promise<void> {
    await this.#run(() => undefined);
  }

  async getLive(userId: string): Promise<LiveRecord | null> {
    return this.#run(() => db.getLive(this.ctx.storage.sql, userId));
  }

  async getAllLives(): Promise<LiveSummary[]> {
    return this.#run(() => db.getAllLives(this.ctx.storage.sql));
  }

  /**
   * 新しい配信を開始してその ID を返す。配信者がすでに配信を持っている場合は null を返す。
   *
   * @throws {Error} `tracks` が getLive で読み戻せない形式の場合。
   */
  async insertLive(
    userId: string,
    sessionId: string,
    tracks: StoredTrack[],
  ): Promise<string | null> {
    return this.#run(() =>
      db.insertLive(this.ctx.storage.sql, userId, sessionId, tracks),
    );
  }

  /**
   * `previousSessionId` を保持している配信を新しいインジェストセッションで継続し、
   * 猶予期間を終了させる。配信がすでに終了したか別のインジェストが先に再開していた場合は
   * false を返す。
   *
   * @throws {Error} `tracks` が getLive で読み戻せない形式の場合。
   */
  async resumeLive(
    userId: string,
    previousSessionId: string,
    sessionId: string,
    tracks: StoredTrack[],
  ): Promise<boolean> {
    return this.#run(() =>
      db.resumeLive(
        this.ctx.storage.sql,
        userId,
        previousSessionId,
        sessionId,
        tracks,
      ),
    );
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
    return this.#run(({ now }) => {
      const graceExpiresAt = now + graceMs;
      return db.startLiveReconnectGrace(
        this.ctx.storage.sql,
        userId,
        sessionId,
        graceExpiresAt,
      )
        ? graceExpiresAt
        : null;
    });
  }

  /**
   * Worker が非アクティブと確認したインジェストセッションの配信を終了させ、
   * 開始通知の削除を Worker に引き渡す。行がすでに猶予期間外で `sessionId` を保持していない
   * 場合は false を返す。
   */
  async endLive(userId: string, sessionId: string): Promise<boolean> {
    return this.#run((run) => {
      const ended = db.endLive(this.ctx.storage.sql, userId, sessionId);
      if (ended === null) {
        return false;
      }

      this.#finishEndedLive(run, ended, "session_inactive");
      return true;
    });
  }

  /**
   * Worker が SFU 上で配信中インジェストセッションの生存を確認したことを、
   * `minIntervalMs` ごとに最大 1 回記録する。記録しなかった場合は false を返す。
   */
  async markLiveSessionSeenActive(
    userId: string,
    sessionId: string,
    minIntervalMs: number,
  ): Promise<boolean> {
    return this.#run(({ now }) =>
      db.markLiveSessionSeenActive(
        this.ctx.storage.sql,
        userId,
        sessionId,
        now,
        minIntervalMs,
      ),
    );
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
      if (
        db.setLiveNotificationMessageId(
          this.ctx.storage.sql,
          userId,
          broadcastId,
          messageId,
        )
      ) {
        return true;
      }

      run.deleteNotificationOnCommit({ messageId, userId });
      return false;
    });
  }

  /** ユーザーの配信者トークンを置き換える。 */
  async setLiveToken(userId: string, tokenHash: string): Promise<void> {
    await this.#run(() => {
      db.setLiveToken(this.ctx.storage.sql, userId, tokenHash);
    });
  }

  async getLiveTokenHash(userId: string): Promise<string | null> {
    return this.#run(() => db.getLiveTokenHash(this.ctx.storage.sql, userId));
  }

  async hasLiveToken(userId: string): Promise<boolean> {
    return this.#run(() => db.hasLiveToken(this.ctx.storage.sql, userId));
  }

  async setUser(user: User): Promise<void> {
    await this.#run(() => {
      db.setUser(this.ctx.storage.sql, user);
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
        };
        for (const ended of db.endOverdueLives(storage.sql, run.now)) {
          this.#finishEndedLive(run, ended, "reconnect_grace_expired");
        }
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

  #finishEndedLive(
    run: CommandRun,
    ended: db.EndedLive,
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
    const wakeAt = db.getNextWakeAt(storage.sql);
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
