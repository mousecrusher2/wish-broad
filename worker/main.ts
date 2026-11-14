// Worker のエントリーポイント。ルーティング定義は ./index にある。このモジュールでは
// Wrangler がバインドするクラスもエクスポートしており、それらは `cloudflare:` ランタイム
// モジュールを必要とするため Node ベースのテスト対象から切り離している。ロジック本体は
// ./live-state と ./live-end にある。
import { retryable } from "cloudflare:durable-objects";
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import type { LiveRecord, User } from "./database";
import app from "./index";
import { runNotificationDeletes } from "./live-end";
import { LiveStateCore, type NotificationDeleteJob } from "./live-state";
import type { StoredTrack } from "./sfu";
import type { Bindings } from "./types";

/**
 * LiveState オブジェクトが開始するが完了を待ってはならない処理群。オブジェクトは
 * `ctx.exports` を通じてこのエントリーポイントを呼び出し、インターネットからは直接ルーティングされない。
 */
export class LiveEffects extends WorkerEntrypoint<Bindings> {
  /**
   * 即座に返却して waitUntil 内で通知を削除することで、呼び出し元オブジェクトが
   * Discord の応答待ち時間に対して課金されないようにする。
   */
  deleteStartNotifications(jobs: NotificationDeleteJob[]): void {
    this.ctx.waitUntil(runNotificationDeletes(this.env, jobs));
  }
}

/**
 * ライブ配信、配信者トークン、およびユーザーを保持し、再接続猶予期間の経過後に
 * 配信を終了させる。詳細は LiveStateCore を参照。
 */
export class LiveState extends DurableObject<Bindings> {
  static {
    // 接続が切れた際、ランタイムはその呼び出しが実行済みかどうかを判別できないため、
    // ここにマークされたメソッドのみを再実行する。開始通知の保存は 2 回実行されても安全であり、
    // ここで失敗させると配信の開始通知が失われてしまう。
    // oxlint-disable-next-line typescript/unbound-method -- retryable はプロトタイプ関数に印を付けるだけで呼び出さないため。
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
