// LiveState Durable Object の状態とタイマー管理: ライブ配信、配信者トークン、ユーザー、
// および再接続猶予期間の経過後に配信を終了させるアラームを扱う。
//
// このオブジェクトは実行または待機に費やした実時間（wall-clock time）に対して課金されるため、
// 自身のストレージ操作のみを行い、Calls・Discord・その他の外部 API は一切呼び出さない。
// それらの呼び出しと結果の報告は Worker 側が行う。オブジェクトが自律的に開始する唯一の外部処理
// である「終了した配信の開始通知の削除」も、`dispatch` を通じて Worker に委譲してそちらで完了させる。
import * as db from "./database";
import { createErrorLogFields, logInfo, logWarn } from "./logger";
import type { StoredTrack } from "./sfu";
import type { Bindings } from "./types";

// 配信一覧の取得ではすべての配信とその配信者名がまとめて必要になるため、1 つの
// オブジェクトで全配信を保持する。負荷は視聴者または配信者の操作ごとに数回の短い呼び出しが
// 発生する程度である。
const LIVE_STATE_NAME = "global";

// Worker に払い出された通知削除タスクは、再度払い出されるまでこの期間だけ非表示になり、
// 試行のたびに倍増する。最初のリース時間は Worker の waitUntil が実行されうる最大 30 秒を
// カバーしており、次の試行が始まる前に前回の試行が確実に終わるようにしている。
const NOTIFICATION_DELETE_LEASE_MS = 30_000;
// 30 秒〜8 分のリース時間により、試行全体が約 15 分以内に収まる。
// 最後の試行でも完了しなかった削除タスクは破棄され、その通知は Discord 上に残る。
const NOTIFICATION_DELETE_MAX_ATTEMPTS = 6;

// これまでの払い出し回数に応じて、削除タスクが払い出された後どれだけの時間非表示になるか。
function getNotificationDeleteLeaseMs(attempts: number): number {
  // 最終試行の後には次の試行がないため、削除タスクが破棄される前に結果を報告するだけの
  // 猶予時間を確保している。
  return attempts + 1 >= NOTIFICATION_DELETE_MAX_ATTEMPTS
    ? NOTIFICATION_DELETE_LEASE_MS
    : NOTIFICATION_DELETE_LEASE_MS * 2 ** attempts;
}

/** Worker が Discord から削除すべき開始通知。 */
export type NotificationDeleteJob = {
  // Discord snowflake（10 進数文字列）。
  messageId: string;
  userId: string;
};

type LiveEndReason = "reconnect_grace_expired" | "session_inactive";

type LiveStateEnv = Pick<Bindings, "ENVIRONMENT" | "LOG_LEVEL">;

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
 * LiveStateCore が使用する Durable Object ストレージのインターフェース。
 *
 * Durable Objects storage のドキュメントにあるとおり、`transaction` クロージャーの
 * 実行中にストレージに対して行われたすべての操作はそのトランザクションの一部となり、
 * `rollback()` で破棄される。アラーム操作もストレージ操作の一種である。`transactionSync` は
 * 同期操作しか対象にできないため、アラーム呼び出しがその外に漏れてしまう。
 */
export type LiveStateStorage = {
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  sql: db.Sql;
  transaction<T>(
    closure: (txn: { rollback(): void }) => Promise<T>,
  ): Promise<T>;
  transactionSync<T>(closure: () => T): T;
};

/**
 * すべてのライブ状態を保持する Durable Object。各メソッドは短時間で完了し、
 * 外部サービスを待機することは一切ない。
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
 * Node ベースのテストでも実行できるよう、./main のクラスから分離した
 * LiveState Durable Object のロジック本体。
 *
 * すべてのメソッドは最初に再接続猶予期間を過ぎた配信を終了させるため、アラームの発火が
 * 遅れていても呼び出し側が期限切れの配信を目にすることはない。Worker が行った Calls
 * リクエストに依存する状態遷移は、Worker が観測したセッションに対する Compare-And-Set で
 * 行う（オブジェクトは自身のメソッド呼び出しは直列化するが、2 つのメソッド間で Worker が
 * 行う外部リクエストまでは直列化しないため）。
 *
 * reject するメソッドは何も保存していない（ストレージ障害であっても値の拒否であっても、
 * トランザクションはロールバックされる）。
 */
export class LiveStateCore {
  readonly #dispatchNotificationDeletes: (
    jobs: NotificationDeleteJob[],
  ) => Promise<void>;
  readonly #env: LiveStateEnv;
  readonly #storage: LiveStateStorage;

  /**
   * @param dispatchNotificationDeletes 通知削除タスクを Worker に引き渡す関数。
   * Discord の応答を待たず、Worker が受け付けた時点ですぐに返却する必要がある。
   */
  constructor(
    storage: LiveStateStorage,
    env: LiveStateEnv,
    dispatchNotificationDeletes: (
      jobs: NotificationDeleteJob[],
    ) => Promise<void>,
  ) {
    this.#storage = storage;
    this.#env = env;
    this.#dispatchNotificationDeletes = dispatchNotificationDeletes;
    storage.transactionSync(() => {
      db.migrateSchema(storage.sql);
    });
  }

  /**
   * 猶予期間の終了時、または通知削除の実行期限到来時に実行される。
   * 期限切れの配信を終了させ、期限に達したすべての削除タスクを Worker に引き渡す。
   */
  async alarm(): Promise<void> {
    const jobs = await this.#run((run) =>
      this.#leaseDueNotificationDeletes(run),
    );
    if (jobs.length === 0) {
      return;
    }

    try {
      await this.#dispatchNotificationDeletes(jobs);
    } catch (error: unknown) {
      // 削除タスクのリース状態は維持されるため、後ほどアラームによって再び払い出される。
      logWarn(this.#env, "live_notification.delete_dispatch_failed", {
        ...createErrorLogFields(error),
        messageIds: jobs.map((job) => job.messageId),
      });
    }
  }

  async getLive(userId: string): Promise<db.LiveRecord | null> {
    return this.#run(() => db.getLive(this.#storage.sql, userId));
  }

  async getAllLives(): Promise<{ owner: db.User }[]> {
    return this.#run(() => db.getAllLives(this.#storage.sql));
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
      db.insertLive(this.#storage.sql, userId, sessionId, tracks),
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
        this.#storage.sql,
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
        this.#storage.sql,
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
      const ended = db.endLive(this.#storage.sql, userId, sessionId);
      if (ended === null) {
        return false;
      }

      this.#finishEndedLive(run, ended, "session_inactive");
      return true;
    });
  }

  /** Worker が Calls 上で配信中インジェストセッションの生存を確認したことを記録する。 */
  async markLiveSessionSeenActive(
    userId: string,
    sessionId: string,
    minIntervalMs: number,
  ): Promise<boolean> {
    return this.#run(({ now }) =>
      db.markLiveSessionSeenActive(
        this.#storage.sql,
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
          this.#storage.sql,
          userId,
          broadcastId,
          messageId,
        )
      ) {
        return true;
      }

      db.enqueueNotificationDelete(this.#storage.sql, messageId, userId, now);
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
        db.removeNotificationDelete(this.#storage.sql, messageId);
      }
    });
  }

  /** ユーザーの配信者トークンを置き換える。 */
  async setLiveToken(userId: string, tokenHash: string): Promise<void> {
    await this.#run(() => {
      db.setLiveToken(this.#storage.sql, userId, tokenHash);
    });
  }

  async getLiveTokenHash(userId: string): Promise<string | null> {
    return this.#run(() => db.getLiveTokenHash(this.#storage.sql, userId));
  }

  async hasLiveToken(userId: string): Promise<boolean> {
    return this.#run(() => db.hasLiveToken(this.#storage.sql, userId));
  }

  async setUser(user: db.User): Promise<void> {
    await this.#run(() => {
      db.setUser(this.#storage.sql, user);
    });
  }

  /**
   * 猶予期間を過ぎた配信を終了させたうえで、1 つのコマンドをストレージトランザクション内で
   * 実行する。同じトランザクション内で次に状態処理が必要となる時刻へアラームを移動するため、
   * 期限や通知削除タスクが対応するアラームなしに保存されることはない。クロージャーは
   * アラーム操作以外では一切 await しない。
   */
  async #run<T>(command: (run: CommandRun) => T): Promise<T> {
    const commitLogs: (() => void)[] = [];
    const result = await this.#storage.transaction(async (txn) => {
      try {
        const run: CommandRun = {
          logOnCommit(write) {
            commitLogs.push(write);
          },
          now: Date.now(),
        };
        for (const ended of db.endOverdueLives(this.#storage.sql, run.now)) {
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
      logInfo(this.#env, "live.ended", {
        reason,
        sessionId: ended.sessionId,
        userId: ended.userId,
      });
    });
    if (ended.notificationMessageId !== null) {
      // 即座に実行期限を迎える: このコマンドが設定するアラームによって Worker に引き渡される。
      db.enqueueNotificationDelete(
        this.#storage.sql,
        ended.notificationMessageId,
        ended.userId,
        run.now,
      );
    }
  }

  #leaseDueNotificationDeletes(run: CommandRun): NotificationDeleteJob[] {
    const jobs: NotificationDeleteJob[] = [];
    for (const entry of db.getDueNotificationDeletes(
      this.#storage.sql,
      run.now,
    )) {
      if (entry.attempts >= NOTIFICATION_DELETE_MAX_ATTEMPTS) {
        db.removeNotificationDelete(this.#storage.sql, entry.messageId);
        run.logOnCommit(() => {
          logWarn(this.#env, "live_notification.delete_abandoned", {
            attempts: entry.attempts,
            messageId: entry.messageId,
            userId: entry.userId,
          });
        });
      } else {
        db.leaseNotificationDelete(
          this.#storage.sql,
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
    const wakeAt = db.getNextWakeAt(this.#storage.sql);
    // アラームハンドラーの実行中に新しいアラームを設定しない限り、この値は null になる
    // （発火中のアラームはすでに設定済みとはみなされない）。
    const scheduledAt = await this.#storage.getAlarm();
    if (wakeAt === scheduledAt) {
      return;
    }

    if (wakeAt === null) {
      await this.#storage.deleteAlarm();
    } else {
      await this.#storage.setAlarm(wakeAt);
    }
  }
}
