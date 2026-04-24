import { WHEPSessionError, type WHEPSessionSnapshot } from "./WHEPClient";

const WHEP_RECONNECT_BASE_DELAY_MS = 500;
const WHEP_RECONNECT_MAX_DELAY_MS = 2_000;

// Recovery is viewer-driven because the Worker does not continuously poll the
// SFU. Keep retries bounded so a truly ended stream becomes visible quickly.
export const WHEP_RECONNECT_WINDOW_MS = 30_000;
export const WHEP_TRACK_DISCOVERY_GRACE_MS = 15_000;
export const WHEP_SESSION_RECOVERY_GRACE_MS = 3_000;

type WHEPReconnectDisposition = "ended" | "error" | "retry";
export type WHEPReconnectAttemptMode = "initial" | "retry";

export function getReconnectDelayMs(
  attemptCount: number,
  remainingMs: number,
): number {
  return Math.max(
    0,
    Math.min(
      WHEP_RECONNECT_BASE_DELAY_MS * 2 ** attemptCount,
      WHEP_RECONNECT_MAX_DELAY_MS,
      remainingMs,
    ),
  );
}

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
): boolean {
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
