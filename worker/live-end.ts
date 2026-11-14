import { WorkerEntrypoint } from "cloudflare:workers";
import { getLiveState, type NotificationDeleteJob } from "./live-state";
import { createErrorLogFields, logWarn } from "./logger";
import {
  deleteLiveStartedNotification,
  DiscordWebhookError,
} from "./notifications";
import type { Bindings } from "./types";

// OBS は再接続のたびに DELETE を送信するため、配信本体は各インジェストセッションより
// この時間だけ長く存続する。この期間内の新しいインジェストは、再度開始通知を送らずに
// 配信を再開する。
export const LIVE_RECONNECT_GRACE_MS = 60_000;

type LiveEndEnv = Pick<
  Bindings,
  | "ENVIRONMENT"
  | "LIVE_STATE"
  | "LOG_LEVEL"
  | "NOTIFICATIONS_DISCORD_WEBHOOK_URL"
>;

// 削除が完了したかどうかを返す。すでに削除済みのメッセージなど、再試行しても
// 回復しない失敗も完了扱いに含める。
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
 * 終了した配信の開始通知を Discord から削除し、どの削除が完了したかを LiveState
 * オブジェクトに報告する。ネットワークエラー、タイムアウト、429、または 5xx で
 * 失敗した削除は未報告のまま残すため、リース期限が切れるとオブジェクトが再び払い出す。
 *
 * この処理はオブジェクト呼び出しの返却後に Worker の waitUntil 内で実行されるため、
 * Discord の応答待ちの間もオブジェクトを実行し続けずに済む。すべての失敗はスローせずここでログ出力する。
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
    // 削除タスクは再度払い出される。その際 Discord はメッセージがすでに存在しない旨を
    // 返すため、それによって削除タスクは完了扱いとなる。
    logWarn(env, "live_notification.settle_failed", {
      ...createErrorLogFields(error),
      messageIds: finishedMessageIds,
    });
  }
}

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
