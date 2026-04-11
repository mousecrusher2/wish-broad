import { WHEPSessionError, type WHEPSessionSnapshot } from "./WHEPClient";

const WHEP_RECONNECT_BASE_DELAY_MS = 500;

export const WHEP_RECONNECT_WINDOW_MS = 30_000;
export const WHEP_SESSION_RECOVERY_GRACE_MS = 3_000;

export type WHEPRetryFailureKind = "error" | "fatal" | "notFound" | "transient";

export function classifyReconnectFailure(error: unknown): WHEPRetryFailureKind {
  if (error instanceof WHEPSessionError) {
    if (!error.retryable) {
      return "fatal";
    }

    if (error.statusCode === 404) {
      return "notFound";
    }

    if (
      error.statusCode !== undefined &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      return "fatal";
    }
  }

  return "error";
}

export function createReconnectDeadline(now = Date.now()): number {
  return now + WHEP_RECONNECT_WINDOW_MS;
}

export function getReconnectDelayMs(
  attemptCount: number,
  remainingMs: number,
): number {
  return Math.max(
    0,
    Math.min(WHEP_RECONNECT_BASE_DELAY_MS * 2 ** attemptCount, remainingMs),
  );
}

export function shouldRecoverEstablishedSession(
  snapshot: WHEPSessionSnapshot,
): boolean {
  if (
    snapshot.status === "connecting" ||
    snapshot.status === "disconnected" ||
    snapshot.status === "failed"
  ) {
    return true;
  }

  return (
    snapshot.expectedRemoteTrackCount > 0 &&
    (snapshot.remoteTrackCount < snapshot.expectedRemoteTrackCount ||
      snapshot.liveTrackCount < snapshot.expectedRemoteTrackCount)
  );
}
