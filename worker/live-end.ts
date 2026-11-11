import { endLive } from "./database";
import { createErrorLogFields, logInfo, logWarn } from "./logger";
import { deleteLiveStartedNotification } from "./notifications";
import type { Bindings } from "./types";

// OBS sends DELETE before every reconnect, so a broadcast outlives each ingest
// session by this long. A new ingest within the period resumes the broadcast
// without another start notification.
export const LIVE_RECONNECT_GRACE_MS = 60_000;

export type LiveEndParams = {
  graceExpiresAt: number;
  sessionId: string;
  userId: string;
};

// The subset of Workflows' WorkflowStep that ending a live needs. Step results
// are persisted, so each callback returns plain serializable values.
type LiveEndStep = {
  do<T extends string | null>(
    name: string,
    callback: () => Promise<T>,
  ): Promise<T>;
  sleepUntil(name: string, timestamp: number): Promise<void>;
};

type LiveEndEnv = Pick<
  Bindings,
  "LIVE_DB" | "LOG_LEVEL" | "NOTIFICATIONS_DISCORD_WEBHOOK_URL"
>;

/**
 * Schedules the end of a broadcast for when its reconnect grace period passes.
 * This is the only place that knows the timer is a Workflow instance.
 */
export async function scheduleLiveEnd(
  env: Pick<Bindings, "LIVE_END_WORKFLOW">,
  params: LiveEndParams,
): Promise<void> {
  await env.LIVE_END_WORKFLOW.create({ params });
}

/**
 * Body of the live-end Workflow. A resumed broadcast is not cancelled here:
 * resuming changes the row's session and clears its grace deadline, so the
 * compare-and-delete below no longer matches and the instance ends quietly.
 */
export async function runLiveEnd(
  env: LiveEndEnv,
  params: LiveEndParams,
  step: LiveEndStep,
): Promise<void> {
  const { graceExpiresAt, sessionId, userId } = params;

  await step.sleepUntil("wait for the publisher to reconnect", graceExpiresAt);

  const messageId = await step.do("end the live", async () => {
    const ended = await endLive(env.LIVE_DB, {
      graceExpiresAt,
      sessionId,
      userId,
    });
    if (ended === null) {
      return null;
    }

    logInfo(env, "live.ended", {
      reason: "reconnect_grace_expired",
      sessionId,
      userId,
    });
    // bigint is not a Workflow step result type; keep the snowflake as text.
    return ended.notificationMessageId?.toString() ?? null;
  });
  if (messageId === null) {
    return;
  }

  try {
    await step.do("delete the start notification", async () => {
      const deleteResult = await deleteLiveStartedNotification(
        env,
        BigInt(messageId),
      );
      if (deleteResult.isOk()) {
        return "deleted";
      }

      // Throwing lets Workflows retry the step with backoff; failures that a
      // retry cannot fix, such as an already deleted message, end here.
      if (deleteResult.error.isRetryable()) {
        throw deleteResult.error;
      }
      logWarn(env, "live_notification.delete_failed", {
        ...createErrorLogFields(deleteResult.error),
        messageId,
        sessionId,
        userId,
      });
      return "failed";
    });
  } catch (error: unknown) {
    // Retries are exhausted. The row is already gone, so only log it.
    logWarn(env, "live_notification.delete_failed", {
      ...createErrorLogFields(error),
      messageId,
      sessionId,
      userId,
    });
  }
}
