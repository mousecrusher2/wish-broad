// 開始通知の送信と削除。どちらもベストエフォートで、失敗はログ出力だけで済ませる
// （docs/architecture.md「通知」）。
import {
  deleteLiveStartedNotification,
  DiscordWebhookError,
  sendLiveStartedNotification,
} from "../clients/discord-webhook";
import { createErrorLogFields, logWarn } from "../lib/logger";
import { getLiveState } from "../state/live-state";
import type { Bindings } from "../types";
import type { NotificationDeleteJob } from "./types";

type NotificationDeleteEnv = Pick<
  Bindings,
  "ENVIRONMENT" | "LOG_LEVEL" | "NOTIFICATIONS_DISCORD_WEBHOOK_URL"
>;

/**
 * 開始通知を送信し、そのメッセージ ID を LiveState に保存する。配信がすでに終了していた
 * 場合は LiveState が削除を Worker に引き渡す。インジェスト応答の返却後に waitUntil 内で
 * 実行されるため、失敗はすべてスローせずログ出力する。
 */
export async function sendStartNotification(
  env: Bindings,
  userId: string,
  broadcastId: string,
  sessionId: string,
  siteUrl: string,
): Promise<void> {
  let messageId: bigint;
  try {
    ({ messageId } = await sendLiveStartedNotification(env, userId, siteUrl));
  } catch (error: unknown) {
    logWarn(env, "live_notification.send_failed", {
      ...createErrorLogFields(error),
      sessionId,
      userId,
    });
    return;
  }

  try {
    await getLiveState(env).setLiveNotificationMessageId(
      userId,
      broadcastId,
      messageId.toString(),
    );
  } catch (error: unknown) {
    logWarn(env, "live_notification.persist_failed", {
      ...createErrorLogFields(error),
      messageId: messageId.toString(),
      sessionId,
      userId,
    });
  }
}

/** 削除できたか、再試行しても成功しない失敗だった場合は true を返す。失敗はログ出力する。 */
async function tryDeleteNotification(
  env: NotificationDeleteEnv,
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
 * 終了した配信の開始通知を Discord から削除する。ネットワークエラー、タイムアウト、429、5xx で
 * 失敗した削除をすぐに 1 回だけ再試行し、それでも失敗したら諦める。waitUntil 内で実行される
 * ため、すべての失敗はスローせずログ出力する。
 */
export async function deleteStartNotifications(
  env: NotificationDeleteEnv,
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
