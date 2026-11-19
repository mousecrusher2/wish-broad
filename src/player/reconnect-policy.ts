import { LIVE_RECONNECTING_RETRY_AFTER_SECONDS } from "../../shared/protocol";
import type { WHEPConnectionStatus, WHEPSessionSnapshot } from "./session";
import { WHEPSessionError } from "./signaling";

// 以下の値の根拠は docs/architecture.md の「フロントエンドのリカバリー」を参照。

/** 再接続のリトライ間隔。Worker が返す `Retry-After` と同じ固定値で、バックオフしない。 */
export const WHEP_RECONNECT_DELAY_MS =
  LIVE_RECONNECTING_RETRY_AFTER_SECONDS * 1_000;

/**
 * 再接続を諦めるまでの時間。Worker の配信者再接続猶予期間（`LIVE_RECONNECT_GRACE_MS`）より
 * 長くなければならない。
 */
export const WHEP_RECONNECT_WINDOW_MS = 75_000;

/**
 * 期待されるすべての受信 RTP レシーバーが統計情報に現れるまで待つ時間。過ぎたら
 * セッションを不完全とみなして作り直す。
 */
export const WHEP_TRACK_DISCOVERY_GRACE_MS = 15_000;

/**
 * 接続済みのセッションが connected でなくなってから置き換えるまでの待ち時間。
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
  status: Exclude<WHEPConnectionStatus, "connected">;
} {
  // ICE は同意確認に失敗すると、disconnected だけでなく checking にも戻りうる
  // （W3C WebRTC の RTCIceTransportState）。そのため connected 以外をすべて回復対象にする。
  return snapshot.status !== "connected";
}
