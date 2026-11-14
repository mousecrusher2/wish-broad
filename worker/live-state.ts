// State and timers of the LiveState Durable Object: live broadcasts, publisher
// tokens, users, and the alarm that ends a broadcast once its reconnect grace
// period passes.
//
// The object is billed for the wall-clock time it spends running or awaiting,
// so it only works on its own storage and never calls Calls, Discord, or any
// other external API. The Worker makes those calls and reports what happened.
// The one thing the object starts by itself, deleting the start notification
// of a broadcast that ended, is handed to the Worker through `dispatch` and
// finishes there.
import * as db from "./database";
import { createErrorLogFields, logInfo, logWarn } from "./logger";
import type { StoredTrack } from "./sfu";
import type { Bindings } from "./types";

// One object holds every broadcast, because listing lives needs all of them
// together with their owners' names. Its load is a handful of short calls per
// viewer or publisher action.
const LIVE_STATE_NAME = "global";

// A notification delete handed to the Worker is hidden for this long, doubled
// on every attempt, before it is handed out again. The first lease covers the
// 30 seconds a Worker's waitUntil may run, so an attempt is over before the
// next one starts.
const NOTIFICATION_DELETE_LEASE_MS = 30_000;
// Leases of 30 seconds to 8 minutes put the attempts within about 15 minutes.
// A delete that the last attempt did not finish is abandoned, and its
// notification stays in Discord.
const NOTIFICATION_DELETE_MAX_ATTEMPTS = 6;

// How long a delete stays hidden once it is handed out, given how often it was
// handed out before.
function getNotificationDeleteLeaseMs(attempts: number): number {
  // No attempt follows the last one, so it only gets the time to report its
  // result before the delete is abandoned.
  return attempts + 1 >= NOTIFICATION_DELETE_MAX_ATTEMPTS
    ? NOTIFICATION_DELETE_LEASE_MS
    : NOTIFICATION_DELETE_LEASE_MS * 2 ** attempts;
}

/** A start notification the Worker should delete from Discord. */
export type NotificationDeleteJob = {
  // The Discord snowflake as decimal text.
  messageId: string;
  userId: string;
};

type LiveEndReason = "reconnect_grace_expired" | "session_inactive";

type LiveStateEnv = Pick<Bindings, "ENVIRONMENT" | "LOG_LEVEL">;

/** What a command gets from the transaction it runs in. */
type CommandRun = {
  /**
   * Queues a log entry that is written once the transaction committed. A
   * command that is rolled back reports nothing, so no entry tells of a
   * change that was not stored.
   */
  logOnCommit(write: () => void): void;
  now: number;
};

/**
 * The part of a Durable Object's storage that LiveStateCore uses.
 *
 * Per the Durable Objects storage documentation, every storage operation made
 * on the storage while a `transaction` closure runs is part of that
 * transaction, and `rollback()` discards them. Alarm calls are storage
 * operations too. `transactionSync` only covers synchronous operations, which
 * leaves the alarm calls out.
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
 * The Durable Object that holds all live state. Its methods are short: none
 * of them waits for an external service.
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
 * Whether a call to the object failed for a reason that may be gone a moment
 * later, so that repeating a call that is safe to repeat can succeed.
 *
 * Per the Durable Objects error handling documentation, such an error has
 * `retryable` set. One that also has `overloaded` set must not be retried:
 * another call adds load to an object that cannot keep up. Repeat the call on
 * a new `getLiveState()` stub, because an exception can leave a stub broken.
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
 * Behavior of the LiveState Durable Object, kept apart from the class in
 * ./main so that it runs in the Node-based tests.
 *
 * Every method first ends the broadcasts whose reconnect grace period passed,
 * so callers never see one even when the alarm is late. Transitions that
 * depend on a Calls request made by the Worker are compare-and-set on the
 * session the Worker observed: the object serializes its own methods, but not
 * the Worker's requests between two of them.
 *
 * A method that rejects has stored nothing: its transaction is rolled back,
 * whether storage failed or a value was refused.
 */
export class LiveStateCore {
  readonly #dispatchNotificationDeletes: (
    jobs: NotificationDeleteJob[],
  ) => Promise<void>;
  readonly #env: LiveStateEnv;
  readonly #storage: LiveStateStorage;

  /**
   * @param dispatchNotificationDeletes Hands notification deletes to the
   * Worker. It must return as soon as the Worker accepted them, without
   * waiting for Discord.
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
   * Runs when a grace period ends or a notification delete is due. Ends the
   * overdue broadcasts and hands every due delete to the Worker.
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
      // The deletes stay leased, so the alarm hands them out again later.
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
   * Starts a new broadcast and returns its id, or null when the owner already
   * has one.
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
   * Continues the broadcast that holds `previousSessionId` with a new ingest
   * session and ends its grace period. Returns false when the broadcast ended
   * or another ingest resumed it first.
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
   * Gives the publisher `graceMs` to reconnect before the broadcast ends, and
   * sets the alarm that ends it in the same transaction. Returns the deadline,
   * or null when the row no longer holds `sessionId` outside a grace period.
   *
   * @throws {Error} When `graceMs` is not an integer.
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
   * Ends the broadcast whose ingest session the Worker found inactive and
   * queues its start notification for deletion. Returns false when the row no
   * longer holds `sessionId` outside a grace period.
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

  /** Records that the Worker found the live ingest session active in Calls. */
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
   * Stores the start notification the Worker sent for a broadcast. If that
   * broadcast already ended, queues the notification for deletion instead and
   * returns false.
   *
   * Calling it again with the same arguments is safe: it stores the same id
   * or finds the delete already queued. The Worker and the runtime rely on
   * that to repeat a call whose outcome they do not know.
   *
   * @throws {Error} When `messageId` is not a Discord snowflake as decimal
   * text.
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
   * Drops notification deletes the Worker finished, either because Discord
   * deleted the message or because trying again cannot succeed.
   */
  async settleNotificationDeletes(messageIds: string[]): Promise<void> {
    await this.#run(() => {
      for (const messageId of messageIds) {
        db.removeNotificationDelete(this.#storage.sql, messageId);
      }
    });
  }

  /** Replaces the user's publisher token. */
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
   * Runs one command in a storage transaction, after ending the broadcasts
   * whose grace period passed. The same transaction moves the alarm to the
   * next time state needs attention, so a deadline or a notification delete is
   * never stored without the alarm that acts on it. The closure awaits nothing
   * but the alarm calls.
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
        // A failed command or alarm call must not leave part of its work.
        txn.rollback();
        throw error;
      }
    });

    // The transaction committed, so what the command changed is stored.
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
      // Due at once: the alarm this command sets hands it to the Worker.
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
   * Moves the alarm to the next time state needs attention. Call it inside
   * the transaction that changed the state.
   *
   * The alarm that is set is read from storage each time. A copy kept in this
   * instance would have to be corrected after every rollback, restart, and
   * alarm run, and one missed case would leave a deadline without its alarm.
   */
  async #moveAlarm(): Promise<void> {
    const wakeAt = db.getNextWakeAt(this.#storage.sql);
    // While the alarm handler runs this is null, unless the handler set a new
    // alarm: the alarm that is firing no longer counts as set.
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
