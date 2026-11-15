import { WHEPSessionError, type WHEPSessionSnapshot } from "./WHEPClient";

// 以下の値の根拠は docs/architecture.md の「フロントエンドのリカバリー」を参照。

/** 再接続のリトライ間隔。Worker の `Retry-After` と同じ固定値で、バックオフしない。 */
export const WHEP_RECONNECT_DELAY_MS = 2_000;

/**
 * 再接続を諦めるまでの時間。Worker の配信者再接続猶予期間
 * （`LIVE_RECONNECT_GRACE_MS`、worker/live/effects.ts）より長くなければならない。
 */
export const WHEP_RECONNECT_WINDOW_MS = 75_000;

/**
 * 期待されるすべての受信 RTP レシーバーが統計情報に現れるまで待つ時間。過ぎたら
 * セッションを不完全とみなして作り直す。
 */
export const WHEP_TRACK_DISCOVERY_GRACE_MS = 15_000;

/**
 * 接続済みのセッションが disconnected / failed になってから置き換えるまでの待ち時間。
 * メディアの停止は、より短い間隔の bytesReceived 監視が別に検知する。
 */
export const WHEP_SESSION_RECOVERY_GRACE_MS = 3_000;

type WHEPReconnectDisposition = "ended" | "error" | "retry";
export type WHEPReconnectAttemptMode = "initial" | "retry";

export function resolveReconnectDisposition(
  error: unknown,
): WHEPReconnectDisposition {
  if (error instanceof WHEPSessionError) {
    if (error.isNotFound()) {
      return "ended";
    }

    if (!error.retryable || error.isClientRequestError()) {
      return "error";
    }
  }

  return "retry";
}

export function shouldRecoverEstablishedSession(
  snapshot: WHEPSessionSnapshot,
): snapshot is WHEPSessionSnapshot & {
  status: "disconnected" | "failed";
} {
  return snapshot.status === "disconnected" || snapshot.status === "failed";
}

export function shouldReconnectForPlaybackStall(stalledForMs: number): boolean {
  return stalledForMs >= 3_000;
}

export function shouldReconnectForTrackDiscoveryTimeout(
  waitingForExpectedTracksMs: number,
): boolean {
  return waitingForExpectedTracksMs >= WHEP_TRACK_DISCOVERY_GRACE_MS;
}
