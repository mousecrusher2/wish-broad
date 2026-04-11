import { WHEPSessionError, type WHEPSessionSnapshot } from "./WHEPClient";

const WHEP_RECONNECT_BASE_DELAY_MS = 500;

export const WHEP_CONNECTING_RESUME_GRACE_MS = 10_000;
export const WHEP_RECONNECT_WINDOW_MS = 10_000;

export type WHEPRetryFailureKind =
  | "error"
  | "fatal"
  | "notFound"
  | "transient";
export type WHEPRetryResolution = "ended" | "error";
export type WHEPRetryResolutionState = {
  sawError: boolean;
  sawNotFound: boolean;
};

export function isInitialPlaybackClientError(error: unknown): boolean {
  if (!(error instanceof WHEPSessionError)) {
    return false;
  }

  if (!error.retryable) {
    return true;
  }

  return (
    error.statusCode !== undefined &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  );
}

export function classifyRetryFailure(error: unknown): WHEPRetryFailureKind {
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

export function updateRetryResolutionState(
  currentValue: WHEPRetryResolutionState | null,
  failureKind: WHEPRetryFailureKind,
): WHEPRetryResolutionState {
  const baseState =
    currentValue ?? {
      sawError: false,
      sawNotFound: false,
    };

  switch (failureKind) {
    case "error":
    case "fatal":
      return {
        ...baseState,
        sawError: true,
      };
    case "notFound":
      return {
        ...baseState,
        sawNotFound: true,
      };
    case "transient":
      return baseState;
    default:
      return failureKind satisfies never;
  }
}

export function shouldReconnectOnResume(
  snapshot: WHEPSessionSnapshot,
  options?: {
    connectingStartedAt?: number | null;
    now?: number;
  },
): boolean {
  if (snapshot.status === "failed" || snapshot.status === "disconnected") {
    return true;
  }

  if (snapshot.status === "connecting") {
    if (snapshot.expectedRemoteTrackCount > 0) {
      return false;
    }

    const connectingStartedAt = options?.connectingStartedAt;
    if (connectingStartedAt === undefined || connectingStartedAt === null) {
      return false;
    }

    return (options?.now ?? Date.now()) - connectingStartedAt >=
      WHEP_CONNECTING_RESUME_GRACE_MS;
  }

  if (snapshot.expectedRemoteTrackCount === 0) {
    return false;
  }

  const expectedRemoteTrackCount = snapshot.expectedRemoteTrackCount;
  return (
    snapshot.remoteTrackCount < expectedRemoteTrackCount ||
    snapshot.liveTrackCount < expectedRemoteTrackCount
  );
}

export function createRetryResolutionState(): WHEPRetryResolutionState {
  return {
    sawError: false,
    sawNotFound: false,
  };
}

export function resolveRetryResolution(
  resolutionState: WHEPRetryResolutionState,
): WHEPRetryResolution {
  return resolutionState.sawNotFound && !resolutionState.sawError
    ? "ended"
    : "error";
}

export function createReconnectDeadline(now = Date.now()): number {
  return now + WHEP_RECONNECT_WINDOW_MS;
}

export function getReconnectDelayMs(
  attemptCount: number,
  remainingMs: number,
): number {
  const baseDelay = WHEP_RECONNECT_BASE_DELAY_MS * 2 ** attemptCount;
  return Math.max(0, Math.min(baseDelay, remainingMs));
}
