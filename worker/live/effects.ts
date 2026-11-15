import { WorkerEntrypoint } from "cloudflare:workers";
import type { Bindings } from "../types";
import { deleteStartNotifications } from "./notifications";
import type { NotificationDeleteJob } from "./types";

/**
 * LiveState オブジェクトが開始するが完了を待ってはならない処理群。オブジェクトは
 * `ctx.exports` を通じてこのエントリーポイントを呼び出し、インターネットからは直接ルーティングされない。
 */
export class LiveEffects extends WorkerEntrypoint<Bindings> {
  /**
   * 即座に返却し、waitUntil 内で通知を削除する。呼び出し元のオブジェクトは Discord の
   * 応答を待たない。
   */
  deleteStartNotifications(jobs: NotificationDeleteJob[]): void {
    this.ctx.waitUntil(deleteStartNotifications(this.env, jobs));
  }
}
