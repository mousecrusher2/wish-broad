// 視聴者の WHEP 再生セッションの開始、カウンターオファーへのアンサー送信、終了。
// 各分岐の根拠は docs/architecture.md の「再生のライフサイクル」を参照。
import {
  createPlaybackSession,
  type PlaybackSession,
  renegotiateSession,
  SfuApiError,
  type SfuNegotiationClientError,
} from "../clients/sfu";
import { createErrorLogFields, logError } from "../lib/logger";
import { getLiveState } from "../state/live-state";
import type { Bindings } from "../types";
import {
  checkLiveSession,
  type LiveSessionStatus,
  startLostSessionGrace,
} from "./session";
import { closeTracksInBackground } from "./tracks";

/**
 * 再生開始の結果。
 *
 * - `started`: `expectedTrackCount` はネゴシエート済みの数ではなく保存済みのトラック数で、
 *   一部のトラックしか得られなかった再生をクライアントに作り直させるために返す。
 * - `not_found`: 配信は終了している。
 * - `reconnecting`: 配信者の再接続を待っている。視聴者はリトライを続ける。
 * - `session_check_failed`: SFU が配信のインジェストセッションの状態を返せなかった。
 * - `negotiation_rejected`: SFU がオファーを拒否した。その応答をそのまま視聴者に返す。
 */
export type StartPlaybackResult =
  | { kind: "started"; expectedTrackCount: number; session: PlaybackSession }
  | { kind: "not_found" }
  | { kind: "reconnecting" }
  | { kind: "session_check_failed" }
  | ({ kind: "negotiation_rejected" } & SfuNegotiationClientError)
  | { kind: "negotiation_failed" };

/**
 * アンサー送信の結果。`negotiation_rejected` は SFU がアンサーを拒否したことを表し、
 * その応答をそのまま視聴者に返す。
 */
export type SubmitPlaybackAnswerResult =
  | { kind: "accepted" }
  | ({ kind: "negotiation_rejected" } & SfuNegotiationClientError)
  | { kind: "negotiation_failed" };

/**
 * `userId` の配信を `viewerUserId` が視聴する再生セッションを開始する。再生セッションを作る前に、
 * 配信のインジェストセッションが生きているかを SFU に確認する。
 */
export async function startPlayback(
  env: Bindings,
  ctx: Pick<ExecutionContext, "waitUntil">,
  userId: string,
  viewerUserId: string,
  sdpOffer: string,
): Promise<StartPlaybackResult> {
  const liveState = getLiveState(env);
  const live = await liveState.getLive(userId);
  if (live === null) {
    return { kind: "not_found" };
  }

  let sessionStatus: LiveSessionStatus;
  try {
    sessionStatus = await checkLiveSession(env, ctx, live);
  } catch (error: unknown) {
    if (!(error instanceof SfuApiError)) {
      throw error;
    }
    logError(env, "play.session_activity_check_failed", {
      ...createErrorLogFields(error),
      sessionId: live.sessionId,
      userId,
    });
    return { kind: "session_check_failed" };
  }

  switch (sessionStatus) {
    case "active":
      break;
    case "reconnect_grace":
      // 保存済みトラックは DELETE 時に閉じられているため、再開か配信終了まで視聴者にリトライさせる。
      return { kind: "reconnecting" };
    case "recently_lost":
      await startLostSessionGrace(env, live);
      return { kind: "reconnecting" };
    case "lost":
      // その間に行が更新されていた場合（OBS が DELETE を送信または再開済み）、
      // 終了を報告するのではなく新しい状態に対して視聴者にリトライさせる。
      return (await liveState.endLive(userId, live.sessionId))
        ? { kind: "not_found" }
        : { kind: "reconnecting" };
  }

  if (live.tracks.length === 0) {
    return { kind: "not_found" };
  }

  let session: PlaybackSession;
  try {
    session = await createPlaybackSession(env, live.tracks, sdpOffer);
  } catch (error: unknown) {
    if (!(error instanceof SfuApiError)) {
      throw error;
    }
    if (error.isSessionNotFound()) {
      // 上で確認した時点ではインジェストセッションは生存していたため、
      // SFU がたった今ガベージコレクションしたとみなせる。
      await startLostSessionGrace(env, live);
      return { kind: "reconnecting" };
    }
    logError(env, "play.negotiation_failed", {
      ...createErrorLogFields(error),
      userId,
      viewerUserId,
    });
    const rejection = error.toNegotiationClientError(
      "Failed to negotiate playback session",
    );
    return rejection
      ? { kind: "negotiation_rejected", ...rejection }
      : { kind: "negotiation_failed" };
  }

  return { kind: "started", expectedTrackCount: live.tracks.length, session };
}

/** SFU が再生開始時に返したカウンターオファーへの、視聴者のアンサーを送信する。 */
export async function submitPlaybackAnswer(
  env: Bindings,
  sessionId: string,
  sdpAnswer: string,
): Promise<SubmitPlaybackAnswerResult> {
  try {
    await renegotiateSession(env, sessionId, sdpAnswer);
  } catch (error: unknown) {
    if (!(error instanceof SfuApiError)) {
      throw error;
    }
    const rejection = error.toNegotiationClientError(
      "Failed to submit WHEP answer",
    );
    if (rejection) {
      return { kind: "negotiation_rejected", ...rejection };
    }

    logError(env, "play.answer_submission_failed", {
      ...createErrorLogFields(error),
      sessionId,
    });
    return { kind: "negotiation_failed" };
  }

  return { kind: "accepted" };
}

/** 視聴者の再生セッションのうち `mids` のトラックを waitUntil 内で閉じる。 */
export function closePlaybackSession(
  env: Bindings,
  ctx: Pick<ExecutionContext, "waitUntil">,
  sessionId: string,
  mids: readonly string[],
): void {
  closeTracksInBackground(env, ctx, sessionId, mids, {
    error: `SFU reported WHEP session close errors for session ${sessionId}:`,
    failure: `Failed to close WHEP session ${sessionId}:`,
  });
}
