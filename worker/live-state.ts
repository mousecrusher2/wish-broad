// LiveState Durable Object。オブジェクトは自身のストレージとアラーム以外を await せず、
// 外部 API は Worker と LiveEffects（./live-end）が呼び出す。理由は docs/architecture.md の
// 「ランタイムモデル」を参照。
import { retryable } from "cloudflare:durable-objects";
import { DurableObject } from "cloudflare:workers";
import * as db from "./database";
import { createErrorLogFields, logInfo, logWarn } from "./logger";
import type { StoredTrack } from "./sfu";
import type { Bindings } from "./types";

/**
 * すべての状態を保持する唯一のオブジェクトの名前。1 つにまとめている理由は
 * docs/architecture.md の「ランタイムモデル」を参照。
 */
const LIVE_STATE_NAME = "global";

/**
 * 払い出した通知削除タスクを再び払い出すまでの最初の期間で、試行のたびに倍になる。
 * Worker の waitUntil が動きうる最大 30 秒をカバーし、前回の試行が終わる前に次の試行を始めない。
 */
const NOTIFICATION_DELETE_LEASE_MS = 30_000;
/** 通知削除の最大試行回数。リース期間と合わせて試行全体が約 15 分に収まる。 */
const NOTIFICATION_DELETE_MAX_ATTEMPTS = 6;

/** これまでの払い出し回数 `attempts` の削除タスクを、今回の払い出し後に非表示にしておく期間。 */
function getNotificationDeleteLeaseMs(attempts: number): number {
  // 最終試行の後には次の試行がないため、削除タスクが破棄される前に結果を報告するだけの
  // 猶予時間を確保している。
  return attempts + 1 >= NOTIFICATION_DELETE_MAX_ATTEMPTS
    ? NOTIFICATION_DELETE_LEASE_MS
    : NOTIFICATION_DELETE_LEASE_MS * 2 ** attempts;
}

/** Worker が Discord から削除すべき開始通知。 */
export type NotificationDeleteJob = {
  /** Discord snowflake（10 進数文字列）。 */
  messageId: string;
  userId: string;
};

type LiveEndReason = "reconnect_grace_expired" | "session_inactive";

/** コマンドが実行中のトランザクションから受け取るコンテキスト。 */
type CommandRun = {
  /**
   * トランザクションのコミット後に書き出すログエントリをキューに追加する。
   * ロールバックされたコマンドは何も報告しないため、保存されなかった変更についてのログは出力されない。
   */
  logOnCommit(write: () => void): void;
  now: number;
};

/**
 * すべてのライブ状態を保持する LiveState オブジェクトのスタブを返す。`retry` を渡すと、
 * このスタブ経由の呼び出しにランタイムの再試行設定を適用する。
 */
export function getLiveState(
  env: Pick<Bindings, "LIVE_STATE">,
  retry?: { maxRetries: number; timeoutMs: number },
) {
  return env.LIVE_STATE.getByName(
    LIVE_STATE_NAME,
    retry === undefined ? undefined : { retry },
  );
}

/**
 * オブジェクトへの呼び出しがすぐ後に解消しうる理由で失敗したか（そのため再実行可能な
 * 呼び出しを繰り返せば成功しうるか）を判定する。
 *
 * Durable Objects のエラーハンドリングドキュメントにあるとおり、そのようなエラーには
 * `retryable` が設定される。ただし `overloaded` も同時に設定されている場合はリトライして
 * はならない（追加入力で負荷が増え、処理が追いつかないオブジェクトをさらに圧迫するため）。
 * 例外発生後はスタブが壊れている可能性があるため、新しい `getLiveState()` スタブで再実行する。
 */
export function isTransientLiveStateError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "retryable" in error &&
    error.retryable === true &&
    !("overloaded" in error && error.overloaded === true)
  );
}

/**
 * ライブ配信、配信者トークン、およびユーザーを保持し、再接続猶予期間の経過後に
 * 配信を終了させる Durable Object。
 *
 * すべてのメソッドは 1 つのトランザクションで実行され、最初に期限切れの配信を終了させる。
 * Worker が Calls で観測した結果に基づく状態遷移は、Worker が観測したセッションに対する
 * Compare-And-Set になっている（docs/architecture.md「配信行（lives）のセマンティクス」）。
 * reject したメソッドは何も保存していない。メソッドがスローしたエラーは RPC を越えると
 * クラスが失われ、同じメッセージの `Error` として呼び出し元に届く。
 */
export class LiveState extends DurableObject<Bindings> {
  static {
    // 接続が切れた際、ランタイムはその呼び出しが実行済みかどうかを判別できないため、
    // ここにマークされたメソッドのみを再実行する。開始通知の保存は 2 回実行されても安全であり、
    // ここで失敗させると配信の開始通知が失われてしまう。
    // oxlint-disable-next-line typescript/unbound-method -- retryable はプロトタイプ関数に印を付けるだけで呼び出さないため。
    retryable(this.prototype.setLiveNotificationMessageId);
  }

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.storage.transactionSync(() => {
      db.migrateSchema(ctx.storage.sql);
    });
  }

  /**
   * 猶予期間の終了時、または通知削除の実行期限到来時に実行される。
   * 期限切れの配信を終了させ、期限に達したすべての削除タスクを Worker に引き渡す。
   */
  override async alarm(): Promise<void> {
    const jobs = await this.#run((run) =>
      this.#leaseDueNotificationDeletes(run),
    );
    if (jobs.length === 0) {
      return;
    }

    try {
      // LiveEffects は即座に返却して waitUntil 内で削除するため、このオブジェクトは
      // Discord の応答を待たない。
      await this.ctx.exports.LiveEffects.deleteStartNotifications(jobs);
    } catch (error: unknown) {
      // 削除タスクのリース状態は維持されるため、後ほどアラームによって再び払い出される。
      logWarn(this.env, "live_notification.delete_dispatch_failed", {
        ...createErrorLogFields(error),
        messageIds: jobs.map((job) => job.messageId),
      });
    }
  }

  async getLive(userId: string): Promise<db.LiveRecord | null> {
    return this.#run(() => db.getLive(this.ctx.storage.sql, userId));
  }

  async getAllLives(): Promise<{ owner: db.User }[]> {
    return this.#run(() => db.getAllLives(this.ctx.storage.sql));
  }

  /**
   * 新しい配信を開始してその ID を返す。配信者がすでに配信を持っている場合は null を返す。
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
   * 開始通知を削除キューに追加する。行がすでに猶予期間外で `sessionId` を保持していない
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
   * Worker が Calls 上で配信中インジェストセッションの生存を確認したことを、
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
   * 代わりにその通知を削除キューに追加して false を返す。
   *
   * 同じ引数で再度呼び出しても安全（同じ ID を保存するか、すでに削除キューに積まれている
   * ことを検出する）。Worker とランタイムは結果不明な呼び出しを再試行するためにこの性質に
   * 依存している。
   *
   * @throws {Error} `messageId` が 10 進数文字列の Discord snowflake でない場合。
   */
  async setLiveNotificationMessageId(
    userId: string,
    broadcastId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.#run(({ now }) => {
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

      db.enqueueNotificationDelete(
        this.ctx.storage.sql,
        messageId,
        userId,
        now,
      );
      return false;
    });
  }

  /**
   * Discord がメッセージを削除したか再試行しても成功し得ないために Worker が完了と
   * 判定した通知削除タスクを削除する。
   */
  async settleNotificationDeletes(messageIds: string[]): Promise<void> {
    await this.#run(() => {
      for (const messageId of messageIds) {
        db.removeNotificationDelete(this.ctx.storage.sql, messageId);
      }
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

  async setUser(user: db.User): Promise<void> {
    await this.#run(() => {
      db.setUser(this.ctx.storage.sql, user);
    });
  }

  /**
   * 猶予期間を過ぎた配信を終了させたうえで、1 つのコマンドをストレージトランザクション内で
   * 実行する。同じトランザクション内で次に状態処理が必要となる時刻へアラームを移動するため、
   * 期限や通知削除タスクが対応するアラームなしに保存されることはない。クロージャーは
   * アラーム操作以外では一切 await しない。`transactionSync()` ではなく `transaction()` を
   * 使う理由は docs/architecture.md の「ランタイムモデル」を参照。
   */
  async #run<T>(command: (run: CommandRun) => T): Promise<T> {
    const { storage } = this.ctx;
    const commitLogs: (() => void)[] = [];
    const result = await storage.transaction(async (txn) => {
      try {
        const run: CommandRun = {
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
    return result;
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
      // 即座に実行期限を迎える: このコマンドが設定するアラームによって Worker に引き渡される。
      db.enqueueNotificationDelete(
        this.ctx.storage.sql,
        ended.notificationMessageId,
        ended.userId,
        run.now,
      );
    }
  }

  #leaseDueNotificationDeletes(run: CommandRun): NotificationDeleteJob[] {
    const { sql } = this.ctx.storage;
    const jobs: NotificationDeleteJob[] = [];
    for (const entry of db.getDueNotificationDeletes(sql, run.now)) {
      if (entry.attempts >= NOTIFICATION_DELETE_MAX_ATTEMPTS) {
        db.removeNotificationDelete(sql, entry.messageId);
        run.logOnCommit(() => {
          logWarn(this.env, "live_notification.delete_abandoned", {
            attempts: entry.attempts,
            messageId: entry.messageId,
            userId: entry.userId,
          });
        });
      } else {
        db.leaseNotificationDelete(
          sql,
          entry.messageId,
          run.now + getNotificationDeleteLeaseMs(entry.attempts),
        );
        jobs.push({ messageId: entry.messageId, userId: entry.userId });
      }
    }
    return jobs;
  }

  /**
   * 次に状態処理が必要となる時刻へアラームを移動する。状態を変更した同じ
   * トランザクション内で呼び出すこと。
   *
   * 現在設定されているアラームは毎回ストレージから読み取る。インスタンス内にキャッシュを持つと
   * ロールバック・再起動・アラーム実行のたびに整合をとり直す必要が生じ、1 つでも見落とすと
   * アラームが設定されていない期限を取り残してしまう。
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
