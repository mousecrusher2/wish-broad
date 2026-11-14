import { getLiveState, type NotificationDeleteJob } from "./live-state";
import { createErrorLogFields, logWarn } from "./logger";
import {
  deleteLiveStartedNotification,
  DiscordWebhookError,
} from "./notifications";
import type { Bindings } from "./types";

// OBS sends DELETE before every reconnect, so a broadcast outlives each ingest
// session by this long. A new ingest within the period resumes the broadcast
// without another start notification.
export const LIVE_RECONNECT_GRACE_MS = 60_000;

type LiveEndEnv = Pick<
  Bindings,
  | "ENVIRONMENT"
  | "LIVE_STATE"
  | "LOG_LEVEL"
  | "NOTIFICATIONS_DISCORD_WEBHOOK_URL"
>;

// Returns whether the delete is finished, which includes a failure that trying
// again cannot fix, such as a message that was already deleted.
async function deleteNotification(
  env: LiveEndEnv,
  job: NotificationDeleteJob,
): Promise<boolean> {
  try {
    await deleteLiveStartedNotification(env, BigInt(job.messageId));
    return true;
  } catch (error: unknown) {
    const willRetry =
      !(error instanceof DiscordWebhookError) || error.isRetryable();
    logWarn(env, "live_notification.delete_failed", {
      ...createErrorLogFields(error),
      messageId: job.messageId,
      userId: job.userId,
      willRetry,
    });
    return !willRetry;
  }
}

/**
 * Deletes the start notifications of ended broadcasts from Discord and tells
 * the LiveState object which deletes are finished. A delete that failed with a
 * network error, timeout, 429, or 5xx is left unreported, so the object hands
 * it out again once its lease expires.
 *
 * This runs in the Worker's waitUntil after the object's call has returned,
 * so the object is not kept running while Discord answers. Every failure is
 * logged here instead of being thrown.
 */
export async function runNotificationDeletes(
  env: LiveEndEnv,
  jobs: readonly NotificationDeleteJob[],
): Promise<void> {
  const finished = await Promise.all(
    jobs.map(async (job) => deleteNotification(env, job)),
  );
  const finishedMessageIds = jobs.flatMap((job, index) =>
    finished[index] === true ? [job.messageId] : [],
  );
  if (finishedMessageIds.length === 0) {
    return;
  }

  try {
    await getLiveState(env).settleNotificationDeletes(finishedMessageIds);
  } catch (error: unknown) {
    // The deletes are handed out again; Discord then reports the messages as
    // gone, which finishes them.
    logWarn(env, "live_notification.settle_failed", {
      ...createErrorLogFields(error),
      messageIds: finishedMessageIds,
    });
  }
}
