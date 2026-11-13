import { WHEPSessionError, type WHEPSessionSnapshot } from "./WHEPClient";

// The Worker states whether a broadcast still exists (503 while the publisher
// reconnects, with `Retry-After: 2`; 404 once it ended), so the client does not
// back off to guess; it retries at the same fixed interval.
export const WHEP_RECONNECT_DELAY_MS = 2_000;

// Recovery is viewer-driven because the Worker does not continuously poll the
// SFU. The Worker answers POST /play with 404 once the 60-second publisher
// reconnect grace period (worker/live-end.ts) passes, even if the scheduled end
// never ran, so playback normally ends there. This window is only a safety net
// against a server that keeps failing or answering 503, so a broken stream does
// not poll forever. It must outlast that grace period.
export const WHEP_RECONNECT_WINDOW_MS = 75_000;

// Receiver stats are the source of truth for media flow. Wait long enough for
// all expected inbound RTP receivers to appear before declaring the WHEP session
// incomplete and replacing it.
export const WHEP_TRACK_DISCOVERY_GRACE_MS = 15_000;

// Once a session was connected, let the browser report a stable disconnected or
// failed state before replacing the WHEP session. Media stalls are handled by the
// shorter bytesReceived monitor above this layer.
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
