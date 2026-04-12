import { WHEPSessionError, type WHEPSessionSnapshot } from "./WHEPClient";

const WHEP_RECONNECT_BASE_DELAY_MS = 500;
const WHEP_RECONNECT_MAX_DELAY_MS = 2_000;

export const WHEP_RECONNECT_WINDOW_MS = 30_000;
export const WHEP_PLAYBACK_STALL_GRACE_MS = 4_000;
export const WHEP_RETRY_PLAYBACK_START_GRACE_MS = 5_000;
export const WHEP_SESSION_RECOVERY_GRACE_MS = 3_000;

export type WHEPReconnectDisposition = "ended" | "error" | "retry";
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
    if (error.statusCode === 404) {
      return "ended";
    }

    if (
      !error.retryable ||
      (error.statusCode !== undefined &&
        error.statusCode >= 400 &&
        error.statusCode < 500)
    ) {
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

export function shouldReconnectForPlaybackStall(
  mode: WHEPReconnectAttemptMode,
  sawPlaybackProgress: boolean,
  stalledForMs: number,
): boolean {
  if (sawPlaybackProgress) {
    return stalledForMs >= WHEP_PLAYBACK_STALL_GRACE_MS;
  }

  return mode === "retry" && stalledForMs >= WHEP_RETRY_PLAYBACK_START_GRACE_MS;
}
