import { WorkerEntrypoint } from "cloudflare:workers";
import type { NotificationDeleteJob } from "../state/live-state";
import { createErrorLogFields, logWarn } from "../lib/logger";
import {
  deleteLiveStartedNotification,
  DiscordWebhookError,
} from "../clients/discord-webhook";
import type { Bindings } from "../types";

/**
 * インジェストの DELETE 後も配信を維持する再接続猶予期間。この期間内の新しいインジェストは
 * 開始通知を送らずに配信を再開する（docs/architecture.md「インジェストのライフサイクル」）。
 */
export const LIVE_RECONNECT_GRACE_MS = 60_000;

type LiveEndEnv = Pick<
  Bindings,
  "ENVIRONMENT" | "LOG_LEVEL" | "NOTIFICATIONS_DISCORD_WEBHOOK_URL"
>;

/** 削除できたか、再試行しても成功しない失敗だった場合は true を返す。失敗はログ出力する。 */
async function tryDeleteNotification(
  env: LiveEndEnv,
  job: NotificationDeleteJob,
  canRetry: boolean,
): Promise<boolean> {
  try {
    await deleteLiveStartedNotification(env, BigInt(job.messageId));
    return true;
  } catch (error: unknown) {
    const retryable =
      !(error instanceof DiscordWebhookError) || error.isRetryable();
    logWarn(env, "live_notification.delete_failed", {
      ...createErrorLogFields(error),
      messageId: job.messageId,
      userId: job.userId,
      willRetry: canRetry && retryable,
    });
    return !retryable;
  }
}

/**
 * 終了した配信の開始通知を Discord から削除する。ベストエフォートのため、ネットワークエラー、
 * タイムアウト、429、5xx で失敗した削除をすぐに 1 回だけ再試行し、それでも失敗したら諦める。
 * waitUntil 内で実行されるため、すべての失敗はスローせずログ出力する。
 */
export async function runNotificationDeletes(
  env: LiveEndEnv,
  jobs: readonly NotificationDeleteJob[],
): Promise<void> {
  await Promise.all(
    jobs.map(async (job) => {
      if (!(await tryDeleteNotification(env, job, true))) {
        await tryDeleteNotification(env, job, false);
      }
    }),
  );
}

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
    this.ctx.waitUntil(runNotificationDeletes(this.env, jobs));
  }
}
