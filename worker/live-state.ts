// State and timers of the LiveState Durable Object: live broadcasts, publisher
// tokens, users, and the alarm that ends a broadcast once its reconnect grace
// period passes.
//
// The object is billed for the wall-clock time it spends running or awaiting,
// so it only runs synchronous SQL and never calls Calls, Discord, or any other
// external API. The Worker makes those calls and reports what happened. The one
// thing the object starts by itself, deleting the start notification of a
// broadcast that ended, is handed to the Worker through `dispatch` and
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
// Leases of 30 seconds to 8 minutes spread the attempts over about 15 minutes,
// after which the notification stays in Discord.
const NOTIFICATION_DELETE_MAX_ATTEMPTS = 6;

/** A start notification the Worker should delete from Discord. */
export type NotificationDeleteJob = {
  // The Discord snowflake as decimal text.
  messageId: string;
  userId: string;
};

type LiveEndReason = "reconnect_grace_expired" | "session_inactive";

type LiveStateEnv = Pick<Bindings, "ENVIRONMENT" | "LOG_LEVEL">;

/** The part of a Durable Object's storage that LiveStateCore uses. */
export type LiveStateStorage = {
  deleteAlarm(): Promise<void>;
  setAlarm(scheduledTime: number): Promise<void>;
  sql: db.Sql;
  transactionSync<T>(closure: () => T): T;
};

/**
 * The Durable Object that holds all live state. Its methods are short: none
 * of them waits for an external service.
 */
export function getLiveState(env: Pick<Bindings, "LIVE_STATE">) {
  return env.LIVE_STATE.getByName(LIVE_STATE_NAME);
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
 */
export class LiveStateCore {
  // When the alarm is set to fire, null when none is set, or undefined when
  // this instance has not set or cleared it since it started.
  #alarmAt: number | null | undefined;
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
    // The alarm that is firing is no longer scheduled.
    this.#alarmAt = null;
    const jobs = await this.#run((now) =>
      this.#leaseDueNotificationDeletes(now),
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
   * sets the alarm that ends it in the same commit. Returns the deadline, or
   * null when the row no longer holds `sessionId` outside a grace period.
   */
  async startLiveReconnectGrace(
    userId: string,
    sessionId: string,
    graceMs: number,
  ): Promise<number | null> {
    return this.#run((now) => {
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
    return this.#run((now) => {
      const ended = db.endLive(this.#storage.sql, userId, sessionId);
      if (ended === null) {
        return false;
      }

      this.#finishEndedLive(ended, "session_inactive", now);
      return true;
    });
  }

  /** Records that the Worker found the live ingest session active in Calls. */
  async markLiveSessionSeenActive(
    userId: string,
    sessionId: string,
    minIntervalMs: number,
  ): Promise<boolean> {
    return this.#run((now) =>
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
   */
  async setLiveNotificationMessageId(
    userId: string,
    broadcastId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.#run((now) => {
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
   * Runs one command in a transaction, after ending the broadcasts whose grace
   * period passed, and then moves the alarm to the next time state needs
   * attention. Nothing is awaited between the SQL and the alarm call, so they
   * commit together.
   */
  async #run<T>(command: (now: number) => T): Promise<T> {
    const result = this.#storage.transactionSync(() => {
      const now = Date.now();
      for (const ended of db.endOverdueLives(this.#storage.sql, now)) {
        this.#finishEndedLive(ended, "reconnect_grace_expired", now);
      }
      return command(now);
    });
    await this.#syncAlarm();
    return result;
  }

  #finishEndedLive(
    ended: db.EndedLive,
    reason: LiveEndReason,
    now: number,
  ): void {
    logInfo(this.#env, "live.ended", {
      reason,
      sessionId: ended.sessionId,
      userId: ended.userId,
    });
    if (ended.notificationMessageId !== null) {
      // Due at once: the alarm set after this command hands it to the Worker.
      db.enqueueNotificationDelete(
        this.#storage.sql,
        ended.notificationMessageId,
        ended.userId,
        now,
      );
    }
  }

  #leaseDueNotificationDeletes(now: number): NotificationDeleteJob[] {
    const jobs: NotificationDeleteJob[] = [];
    for (const entry of db.getDueNotificationDeletes(this.#storage.sql, now)) {
      if (entry.attempts >= NOTIFICATION_DELETE_MAX_ATTEMPTS) {
        db.removeNotificationDelete(this.#storage.sql, entry.messageId);
        logWarn(this.#env, "live_notification.delete_abandoned", {
          attempts: entry.attempts,
          messageId: entry.messageId,
          userId: entry.userId,
        });
      } else {
        db.leaseNotificationDelete(
          this.#storage.sql,
          entry.messageId,
          now + NOTIFICATION_DELETE_LEASE_MS * 2 ** entry.attempts,
        );
        jobs.push({ messageId: entry.messageId, userId: entry.userId });
      }
    }
    return jobs;
  }

  async #syncAlarm(): Promise<void> {
    const wakeAt = db.getNextWakeAt(this.#storage.sql);
    const scheduledAt = this.#alarmAt;
    if (wakeAt === scheduledAt) {
      return;
    }

    this.#alarmAt = wakeAt;
    if (wakeAt !== null) {
      await this.#storage.setAlarm(wakeAt);
    } else if (scheduledAt !== undefined) {
      // A restarted instance does not know whether an alarm is set. Leaving
      // one set is harmless: it fires, finds nothing to do, and is not set
      // again, which costs less than clearing on every first call.
      await this.#storage.deleteAlarm();
    }
  }
}
