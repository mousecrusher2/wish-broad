// Worker entrypoint. Routes live in ./index; this module also exports the
// classes Wrangler binds, which need the `cloudflare:` runtime modules and
// therefore stay out of the Node-based tests. Their behavior lives in
// ./live-state and ./live-end.
import { retryable } from "cloudflare:durable-objects";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { LiveRecord, User } from "./database";
import app from "./index";
import { runNotificationDeletes } from "./live-end";
import { LiveStateCore, type NotificationDeleteJob } from "./live-state";
import type { StoredTrack } from "./sfu";
import type { Bindings } from "./types";

/**
 * Work the LiveState object starts but must not wait for. The object reaches
 * this entrypoint through `ctx.exports`; it is not routed from the internet.
 */
export class LiveEffects extends WorkerEntrypoint<Bindings> {
  /**
   * Returns at once and deletes the notifications in waitUntil, so the calling
   * object is not billed for the time Discord takes to answer.
   */
  deleteStartNotifications(jobs: NotificationDeleteJob[]): void {
    this.ctx.waitUntil(runNotificationDeletes(this.env, jobs));
  }
}

/**
 * Holds live broadcasts, publisher tokens, and users, and ends a broadcast
 * once its reconnect grace period passes. See LiveStateCore.
 */
export class LiveState extends DurableObject<Bindings> {
  static {
    // When a connection drops, the runtime cannot tell whether the call it
    // carried ran, and repeats it only for a method marked here. Storing a
    // notification is safe to run twice, and failing it instead costs the
    // broadcast its start notification.
    // oxlint-disable-next-line typescript/unbound-method -- retryable marks the prototype function; it does not call it.
    retryable(this.prototype.setLiveNotificationMessageId);
  }

  readonly #core: LiveStateCore;

  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    this.#core = new LiveStateCore(ctx.storage, env, async (jobs) => {
      await ctx.exports.LiveEffects.deleteStartNotifications(jobs);
    });
  }

  override async alarm(): Promise<void> {
    await this.#core.alarm();
  }

  async getLive(userId: string): Promise<LiveRecord | null> {
    return this.#core.getLive(userId);
  }

  async getAllLives(): Promise<{ owner: User }[]> {
    return this.#core.getAllLives();
  }

  async insertLive(
    userId: string,
    sessionId: string,
    tracks: StoredTrack[],
  ): Promise<string | null> {
    return this.#core.insertLive(userId, sessionId, tracks);
  }

  async resumeLive(
    userId: string,
    previousSessionId: string,
    sessionId: string,
    tracks: StoredTrack[],
  ): Promise<boolean> {
    return this.#core.resumeLive(userId, previousSessionId, sessionId, tracks);
  }

  async startLiveReconnectGrace(
    userId: string,
    sessionId: string,
    graceMs: number,
  ): Promise<number | null> {
    return this.#core.startLiveReconnectGrace(userId, sessionId, graceMs);
  }

  async endLive(userId: string, sessionId: string): Promise<boolean> {
    return this.#core.endLive(userId, sessionId);
  }

  async markLiveSessionSeenActive(
    userId: string,
    sessionId: string,
    minIntervalMs: number,
  ): Promise<boolean> {
    return this.#core.markLiveSessionSeenActive(
      userId,
      sessionId,
      minIntervalMs,
    );
  }

  async setLiveNotificationMessageId(
    userId: string,
    broadcastId: string,
    messageId: string,
  ): Promise<boolean> {
    return this.#core.setLiveNotificationMessageId(
      userId,
      broadcastId,
      messageId,
    );
  }

  async settleNotificationDeletes(messageIds: string[]): Promise<void> {
    await this.#core.settleNotificationDeletes(messageIds);
  }

  async setLiveToken(userId: string, tokenHash: string): Promise<void> {
    await this.#core.setLiveToken(userId, tokenHash);
  }

  async getLiveTokenHash(userId: string): Promise<string | null> {
    return this.#core.getLiveTokenHash(userId);
  }

  async hasLiveToken(userId: string): Promise<boolean> {
    return this.#core.hasLiveToken(userId);
  }

  async setUser(user: User): Promise<void> {
    await this.#core.setUser(user);
  }
}

export default app;
