// WHIP インジェストの開始と終了。各分岐の根拠は docs/architecture.md の
// 「インジェストのライフサイクル」を参照。
import { LIVE_RECONNECT_GRACE_MS } from "../../shared/protocol";
import {
  createIngestSession,
  type IngestSession,
  SfuApiError,
  type SfuNegotiationClientError,
} from "../clients/sfu";
import {
  createErrorLogFields,
  logError,
  logInfo,
  logWarn,
} from "../lib/logger";
import { getLiveState } from "../state/live-state";
import type { Bindings } from "../types";
import { sendStartNotification } from "./notifications";
import { checkLiveSession, type LiveSessionStatus } from "./session";
import { closeTracksInBackground } from "./tracks";
import type { LiveRecord } from "./types";

/**
 * インジェスト開始の結果。
 *
 * - `already_active`: 保存済みセッションがまだ SFU 上でアクティブか、並行するインジェストが
 *   先に配信を確保した。
 * - `session_check_failed`: SFU が保存済みセッションの状態を返せなかった。
 * - `negotiation_rejected`: SFU がオファーを拒否した。その応答をそのまま OBS に返す。
 * - `deadline_exceeded`: SFU とのネゴシエーションは済んだが、締め切りを過ぎたため配信を始めなかった。
 */
export type StartIngestResult =
  | { kind: "started" | "resumed"; session: IngestSession }
  | { kind: "already_active" }
  | { kind: "session_check_failed" }
  | ({ kind: "negotiation_rejected" } & SfuNegotiationClientError)
  | { kind: "negotiation_failed" }
  | { kind: "deadline_exceeded" };

/**
 * インジェスト終了の結果。
 *
 * - `already_in_grace`: すでに終了済みのインジェストに対する重複 DELETE。
 * - `grace_not_started`: 行を読み取った後で、別のリクエストが配信を終了させたか再開した。
 */
export type EndIngestResult =
  | "grace_started"
  | "already_in_grace"
  | "no_live"
  | "session_mismatch"
  | "invalid_stored_tracks"
  | "grace_not_started";

/**
 * インジェスト開始の締め切り。過ぎたら SFU への呼び出しを打ち切り、配信行を書き込まずに失敗する。
 * 値の根拠は docs/architecture.md の「インジェストのライフサイクル」を参照。
 */
const INGEST_DEADLINE_MS = 6_000;

type IngestTarget =
  | { kind: "new" }
  | { kind: "resume"; live: LiveRecord }
  | { kind: "reject"; result: StartIngestResult };

/** 配信者の既存の配信行から、新しいインジェストが配信を再開するか、新しく始めるか、拒否されるかを決める。 */
async function resolveIngestTarget(
  env: Bindings,
  ctx: Pick<ExecutionContext, "waitUntil">,
  existingLive: LiveRecord | null,
  deadline: AbortSignal,
): Promise<IngestTarget> {
  if (existingLive === null) {
    return { kind: "new" };
  }

  let sessionStatus: LiveSessionStatus;
  try {
    sessionStatus = await checkLiveSession(env, ctx, existingLive, deadline);
  } catch (error: unknown) {
    if (!(error instanceof SfuApiError)) {
      throw error;
    }
    logError(env, "ingest.session_activity_check_failed", {
      ...createErrorLogFields(error),
      sessionId: existingLive.sessionId,
      userId: existingLive.userId,
    });
    return { kind: "reject", result: { kind: "session_check_failed" } };
  }

  switch (sessionStatus) {
    case "active":
      return { kind: "reject", result: { kind: "already_active" } };
    case "reconnect_grace":
    case "recently_lost":
      // OBS の再接続とみなし、通知せずに配信を再開する。
      return { kind: "resume", live: existingLive };
    case "lost":
      // ずっと前に失われたセッションかもしれないため、新しい配信として開始して通知する。
      // その間に行が更新されていた場合は、後続の insertLive がこのインジェストを拒否する。
      await getLiveState(env).endLive(
        existingLive.userId,
        existingLive.sessionId,
      );
      return { kind: "new" };
  }
}

/**
 * WHIP インジェストを開始する。OBS の再接続待ちの配信があれば通知せずに再開し、なければ
 * 新しい配信を開始する。新しい配信を開始したときは、`notifySiteUrl` が null でなければ
 * その URL を載せた開始通知を waitUntil 内で送る。
 */
export async function startIngest(
  env: Bindings,
  ctx: Pick<ExecutionContext, "waitUntil">,
  userId: string,
  sdpOffer: string,
  notifySiteUrl: string | null,
): Promise<StartIngestResult> {
  const deadline = new AbortController();
  const deadlineTimeoutId = setTimeout(() => {
    deadline.abort();
  }, INGEST_DEADLINE_MS);
  try {
    return await startIngestWithinDeadline(
      deadline.signal,
      env,
      ctx,
      userId,
      sdpOffer,
      notifySiteUrl,
    );
  } finally {
    clearTimeout(deadlineTimeoutId);
  }
}

/** `startIngest` の本体。`deadline` が中断されたら SFU への呼び出しを打ち切り、配信行を書き込まない。 */
async function startIngestWithinDeadline(
  deadline: AbortSignal,
  env: Bindings,
  ctx: Pick<ExecutionContext, "waitUntil">,
  userId: string,
  sdpOffer: string,
  notifySiteUrl: string | null,
): Promise<StartIngestResult> {
  const liveState = getLiveState(env);
  const target = await resolveIngestTarget(
    env,
    ctx,
    await liveState.getLive(userId),
    deadline,
  );
  if (target.kind === "reject") {
    return target.result;
  }

  let session: IngestSession;
  try {
    session = await createIngestSession(env, sdpOffer, deadline);
  } catch (error: unknown) {
    if (!(error instanceof SfuApiError)) {
      throw error;
    }
    const rejection = error.toNegotiationClientError(
      "Failed to negotiate ingest session",
    );
    if (rejection) {
      return { kind: "negotiation_rejected", ...rejection };
    }

    logError(env, "ingest.negotiation_failed", {
      ...createErrorLogFields(error),
      userId,
    });
    return { kind: "negotiation_failed" };
  }

  if (deadline.aborted) {
    // OBS が応答を待つのをやめた後に配信を始めないよう、配信行を書き込む前に確かめる。
    // この SFU セッションは誰も使わず、SFU が自動で片付ける。
    logWarn(env, "ingest.deadline_exceeded", {
      sessionId: session.sessionId,
      userId,
    });
    return { kind: "deadline_exceeded" };
  }

  if (
    target.kind === "resume" &&
    (await liveState.resumeLive(
      userId,
      target.live.sessionId,
      session.sessionId,
      session.tracks,
    ))
  ) {
    logInfo(env, "ingest.resumed", {
      previousSessionId: target.live.sessionId,
      reason:
        target.live.graceExpiresAt === null
          ? "session_lost"
          : "reconnect_grace",
      sessionId: session.sessionId,
      userId,
    });
    return { kind: "resumed", session };
  }

  // 再開対象がそもそも存在しなかったか、セッションのネゴシエーション中に配信が
  // 終了したため、新しい配信を開始する。
  const broadcastId = await liveState.insertLive(
    userId,
    session.sessionId,
    session.tracks,
  );
  if (broadcastId === null) {
    // 行を読み取った後で、競合する別のインジェストが先に行を作成または再開した。
    // このインジェストの SFU セッションは誰も使わず、SFU が自動で片付ける。
    logWarn(env, "ingest.concurrent_ingest_rejected", {
      sessionId: session.sessionId,
      userId,
    });
    return { kind: "already_active" };
  }

  if (notifySiteUrl !== null) {
    ctx.waitUntil(
      sendStartNotification(
        env,
        userId,
        broadcastId,
        session.sessionId,
        notifySiteUrl,
      ),
    );
  }

  return { kind: "started", session };
}

/**
 * 現在保存されているインジェストセッションの DELETE を受けて再接続猶予期間を始め、
 * 保存済みトラックを waitUntil 内で閉じる。DELETE は再接続と区別できないため、配信は終了させない。
 */
export async function endIngest(
  env: Bindings,
  ctx: Pick<ExecutionContext, "waitUntil">,
  userId: string,
  sessionId: string,
): Promise<EndIngestResult> {
  const liveState = getLiveState(env);
  const existingLive = await liveState.getLive(userId);
  if (!existingLive) {
    return "no_live";
  }
  if (existingLive.sessionId !== sessionId) {
    return "session_mismatch";
  }
  if (existingLive.graceExpiresAt !== null) {
    return "already_in_grace";
  }
  if (
    existingLive.tracks.length === 0 ||
    existingLive.tracks.some((track) => track.mid.length === 0)
  ) {
    return "invalid_stored_tracks";
  }

  const graceExpiresAt = await liveState.startLiveReconnectGrace(
    userId,
    sessionId,
    LIVE_RECONNECT_GRACE_MS,
  );
  if (graceExpiresAt === null) {
    return "grace_not_started";
  }

  // このインジェストセッションが終了したため、保存済みトラックロケーターは無効になる。
  closeTracksInBackground(
    env,
    ctx,
    sessionId,
    existingLive.tracks.map((track) => track.mid),
    {
      error: `SFU reported track close errors for user ${userId}:`,
      failure: `Failed to close live tracks for user ${userId}:`,
    },
  );
  return "grace_started";
}
