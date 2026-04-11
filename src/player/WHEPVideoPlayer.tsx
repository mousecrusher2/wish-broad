import { useCallback, useEffect, useRef, useState } from "react";
import type { RefCallback } from "react";
import {
  WHEPSession,
  WHEPSessionError,
  type WHEPConnectionStatus,
  type WHEPSessionSnapshot,
} from "./WHEPClient";
import {
  createRetryResolutionState,
  classifyRetryFailure,
  createReconnectDeadline,
  getReconnectDelayMs,
  isInitialPlaybackClientError,
  resolveRetryResolution,
  shouldReconnectOnResume,
  updateRetryResolutionState,
  type WHEPRetryResolutionState,
  type WHEPRetryFailureKind,
} from "./whep-reconnect";

export type WHEPPlaybackPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "error";

export type WHEPPlaybackState = {
  connectionStatus: WHEPConnectionStatus;
  hasStream: boolean;
  message: string | null;
  phase: WHEPPlaybackPhase;
  resourceUserId: string | null;
  retryCount: number;
};

export type WHEPVideoPlayerHandlers = {
  load: (resourceUserId: string) => void;
  disconnect: () => void;
};

type WHEPVideoPlayerProps = {
  onError?: (error: Error) => void;
  onHandlersChange?: (handlers: WHEPVideoPlayerHandlers) => void;
  onLoadingChange?: (isLoading: boolean) => void;
  onPlaybackStateChange?: (state: WHEPPlaybackState) => void;
  onStatusChange?: (status: WHEPConnectionStatus) => void;
};

type RetryState = {
  attemptCount: number;
  deadlineAt: number;
  resolutionState: WHEPRetryResolutionState;
};

type PendingAttempt = {
  loadingToken: number | null;
  mode: "initial" | "retry";
  resourceUserId: string;
};

const POST_CONNECT_RECONNECT_GRACE_MS = 3_000;
const DISCONNECTED_RECONNECT_GRACE_MS = 3_000;
const NO_STREAM_RECONNECT_GRACE_MS = 3_000;
const FROZEN_PLAYBACK_RECONNECT_GRACE_MS = 6_000;
const SESSION_HEALTH_CHECK_INTERVAL_MS = 2_000;

function noop(): void {}

const noopWHEPVideoPlayerHandlers: WHEPVideoPlayerHandlers = {
  load: noop,
  disconnect: noop,
};

function assertUnreachablePhase(phase: never): never {
  void phase;
  throw new Error("Unexpected playback phase");
}

function createIdlePlaybackState(): WHEPPlaybackState {
  return {
    connectionStatus: "disconnected",
    hasStream: false,
    message: null,
    phase: "idle",
    resourceUserId: null,
    retryCount: 0,
  };
}

function createPlaybackState(
  resourceUserId: string,
  phase: WHEPPlaybackPhase,
  connectionStatus: WHEPConnectionStatus,
  retryCount: number,
): WHEPPlaybackState {
  return {
    connectionStatus,
    hasStream: false,
    message: getPhaseMessage(phase),
    phase,
    resourceUserId,
    retryCount,
  };
}

function getPhaseMessage(phase: WHEPPlaybackPhase): string | null {
  switch (phase) {
    case "idle":
    case "connected":
      return null;
    case "connecting":
      return "接続中...";
    case "reconnecting":
      return "再接続中...";
    case "ended":
      return "配信は終了しました";
    case "error":
      return "接続エラーが発生しました";
    default:
      return assertUnreachablePhase(phase);
  }
}

function getVideoPlaceholderText(playbackState: WHEPPlaybackState): string {
  switch (playbackState.phase) {
    case "idle":
      return "配信を選択して「Load」ボタンを押してください";
    case "connecting":
      return "接続中...";
    case "reconnecting":
      return "再接続中...";
    case "ended":
      return "配信は終了しました";
    case "error":
      return "接続エラーが発生しました";
    case "connected":
      return "映像を待機中...";
    default:
      return assertUnreachablePhase(playbackState.phase);
  }
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function VideoPlaceholder({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm leading-7 text-slate-400">
      {message}
    </div>
  );
}

export function WHEPVideoPlayer({
  onError,
  onHandlersChange,
  onLoadingChange,
  onPlaybackStateChange,
  onStatusChange,
}: WHEPVideoPlayerProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [playbackState, setPlaybackState] = useState<WHEPPlaybackState>(
    createIdlePlaybackState,
  );
  const [videoElement, setVideoElement] = useState<HTMLVideoElement | null>(
    null,
  );
  const attemptIdRef = useRef(0);
  const attemptStartedAtRef = useRef<number | null>(null);
  const initialLoadTokenRef = useRef(0);
  const pendingAttemptRef = useRef<PendingAttempt | null>(null);
  const disconnectedReconnectTimerRef = useRef<number | null>(null);
  const frozenPlaybackStateRef = useRef<{
    lastCurrentTime: number;
    lastProgressAt: number;
    noStreamSinceAt: number | null;
  } | null>(null);
  const postConnectReconnectTimerRef = useRef<number | null>(null);
  const retryStateRef = useRef<RetryState | null>(null);
  const retryScheduledAtRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryAttemptInFlightRef = useRef(false);
  const sessionRef = useRef<WHEPSession | null>(null);
  const startPlaybackAttemptRef = useRef<
    ((
      resourceUserId: string,
      mode: "initial" | "retry",
      loadingToken?: number | null,
    ) => Promise<void>) | null
  >(null);
  const targetResourceRef = useRef<string | null>(null);

  const mountVideo = useCallback<RefCallback<HTMLVideoElement>>(
    (mountedVideoElement) => {
      setVideoElement(mountedVideoElement);
    },
    [],
  );

  const clearPostConnectReconnectTimer = useCallback(() => {
    const reconnectTimerId = postConnectReconnectTimerRef.current;
    if (reconnectTimerId === null) {
      return;
    }

    window.clearTimeout(reconnectTimerId);
    postConnectReconnectTimerRef.current = null;
  }, []);

  const clearDisconnectedReconnectTimer = useCallback(() => {
    const disconnectedTimerId = disconnectedReconnectTimerRef.current;
    if (disconnectedTimerId === null) {
      return;
    }

    window.clearTimeout(disconnectedTimerId);
    disconnectedReconnectTimerRef.current = null;
  }, []);

  const clearFrozenPlaybackState = useCallback(() => {
    frozenPlaybackStateRef.current = null;
  }, []);

  const clearRetryTimer = useCallback(() => {
    const retryTimerId = retryTimerRef.current;
    retryScheduledAtRef.current = null;
    if (retryTimerId === null) {
      return;
    }

    window.clearTimeout(retryTimerId);
    retryTimerRef.current = null;
  }, []);

  const replaceSession = useCallback((nextSession: WHEPSession | null) => {
    const previousSession = sessionRef.current;
    sessionRef.current = nextSession;

    if (previousSession && previousSession !== nextSession) {
      void previousSession.dispose({ notifyServer: true });
    }
  }, []);

  const stopPlayback = useCallback(
    (options?: { resetState?: boolean }) => {
      clearPostConnectReconnectTimer();
      clearDisconnectedReconnectTimer();
      clearFrozenPlaybackState();
      clearRetryTimer();
      attemptStartedAtRef.current = null;
      pendingAttemptRef.current = null;
      retryStateRef.current = null;
      retryAttemptInFlightRef.current = false;
      setIsLoading(false);
      replaceSession(null);

      if (options?.resetState === false) {
        return;
      }

      setPlaybackState(createIdlePlaybackState());
    },
    [
      clearDisconnectedReconnectTimer,
      clearFrozenPlaybackState,
      clearPostConnectReconnectTimer,
      clearRetryTimer,
      replaceSession,
    ],
  );

  const finalizePlayback = useCallback(
    (
      phase: Extract<WHEPPlaybackPhase, "ended" | "error" | "idle">,
      resourceUserId: string | null,
      error?: Error,
    ) => {
      if (phase === "ended" || phase === "error") {
        targetResourceRef.current = null;
      }

      if (phase === "idle") {
        stopPlayback();
        return;
      }

      stopPlayback({ resetState: false });
      setPlaybackState({
        connectionStatus: phase === "ended" ? "disconnected" : "failed",
        hasStream: false,
        message: getPhaseMessage(phase),
        phase,
        resourceUserId,
        retryCount: 0,
      });

      if (phase === "error" && error) {
        onError?.(error);
      }
    },
    [onError, stopPlayback],
  );

  const startRetryAttempt = useCallback(
    (resourceUserId: string) => {
      if (targetResourceRef.current !== resourceUserId) {
        return;
      }

      if (retryAttemptInFlightRef.current) {
        return;
      }

      const retryState = retryStateRef.current;
      if (!retryState) {
        return;
      }

      const retryNow = Date.now();
      if (retryNow >= retryState.deadlineAt) {
        finalizePlayback(
          resolveRetryResolution(retryState.resolutionState),
          resourceUserId,
          retryState.resolutionState.sawNotFound &&
            !retryState.resolutionState.sawError
            ? undefined
            : new Error("WHEP reconnect window expired"),
        );
        return;
      }

      clearRetryTimer();
      retryAttemptInFlightRef.current = true;
      retryStateRef.current = {
        ...retryState,
        attemptCount: retryState.attemptCount + 1,
      };

      const startPlaybackAttempt = startPlaybackAttemptRef.current;
      if (!startPlaybackAttempt) {
        retryAttemptInFlightRef.current = false;
        return;
      }

      void startPlaybackAttempt(resourceUserId, "retry");
    },
    [clearRetryTimer, finalizePlayback],
  );

  const scheduleReconnect = useCallback(
    (
      resourceUserId: string,
      failureKind: WHEPRetryFailureKind,
      options?: { immediate?: boolean },
    ) => {
      if (targetResourceRef.current !== resourceUserId) {
        return;
      }

      clearPostConnectReconnectTimer();
      const now = Date.now();
      const currentRetryState = retryStateRef.current;
      const nextRetryState =
        currentRetryState === null
          ? {
              attemptCount: 0,
              deadlineAt: createReconnectDeadline(now),
              resolutionState: updateRetryResolutionState(
                createRetryResolutionState(),
                failureKind,
              ),
            }
          : {
              ...currentRetryState,
              resolutionState: updateRetryResolutionState(
                currentRetryState.resolutionState,
                failureKind,
              ),
            };
      retryStateRef.current = nextRetryState;
      retryAttemptInFlightRef.current = false;

      if (now >= nextRetryState.deadlineAt) {
        finalizePlayback(
          resolveRetryResolution(nextRetryState.resolutionState),
          resourceUserId,
          nextRetryState.resolutionState.sawNotFound &&
            !nextRetryState.resolutionState.sawError
            ? undefined
            : failureKind === "error"
            ? new Error("WHEP reconnect window expired")
            : undefined,
        );
        return;
      }

      setPlaybackState((currentPlaybackState) => ({
        ...currentPlaybackState,
        connectionStatus:
          currentPlaybackState.connectionStatus === "connected"
            ? "connecting"
            : currentPlaybackState.connectionStatus,
        hasStream:
          failureKind === "transient" && currentPlaybackState.phase === "connected"
            ? currentPlaybackState.hasStream
            : false,
        message: getPhaseMessage("reconnecting"),
        phase: "reconnecting",
        resourceUserId,
        retryCount: nextRetryState.attemptCount,
      }));

      if (options?.immediate) {
        clearRetryTimer();
        startRetryAttempt(resourceUserId);
        return;
      }

      if (retryTimerRef.current !== null && retryScheduledAtRef.current !== null) {
        return;
      }

      const retryDelayMs = getReconnectDelayMs(
        nextRetryState.attemptCount,
        nextRetryState.deadlineAt - now,
      );
      retryScheduledAtRef.current = now + retryDelayMs;
      retryTimerRef.current = window.setTimeout(() => {
        startRetryAttempt(resourceUserId);
      }, retryDelayMs);
    },
    [
      clearPostConnectReconnectTimer,
      clearRetryTimer,
      finalizePlayback,
      startRetryAttempt,
    ],
  );

  const armPostConnectReconnect = useCallback(
    (
      resourceUserId: string,
      session: WHEPSession,
      sessionAttemptId: number,
    ) => {
      if (targetResourceRef.current !== resourceUserId) {
        return;
      }

      setPlaybackState((currentPlaybackState) => ({
        ...currentPlaybackState,
        connectionStatus: "connecting",
      }));

      if (
        postConnectReconnectTimerRef.current !== null ||
        retryAttemptInFlightRef.current ||
        retryStateRef.current !== null
      ) {
        return;
      }

      postConnectReconnectTimerRef.current = window.setTimeout(() => {
        postConnectReconnectTimerRef.current = null;
        if (
          attemptIdRef.current !== sessionAttemptId ||
          targetResourceRef.current !== resourceUserId ||
          sessionRef.current !== session
        ) {
          return;
        }

        if (session.getSnapshot().status !== "connecting") {
          return;
        }

        scheduleReconnect(resourceUserId, "transient");
      }, POST_CONNECT_RECONNECT_GRACE_MS);
    },
    [scheduleReconnect],
  );

  const armDisconnectedReconnect = useCallback(
    (
      resourceUserId: string,
      session: WHEPSession,
      sessionAttemptId: number,
    ) => {
      if (targetResourceRef.current !== resourceUserId) {
        return;
      }

      if (
        disconnectedReconnectTimerRef.current !== null ||
        retryAttemptInFlightRef.current ||
        retryStateRef.current !== null
      ) {
        return;
      }

      disconnectedReconnectTimerRef.current = window.setTimeout(() => {
        disconnectedReconnectTimerRef.current = null;
        if (
          attemptIdRef.current !== sessionAttemptId ||
          targetResourceRef.current !== resourceUserId ||
          sessionRef.current !== session
        ) {
          return;
        }

        if (session.getSnapshot().status !== "disconnected") {
          return;
        }

        attemptIdRef.current += 1;
        sessionRef.current = null;
        void session.dispose({ notifyServer: true });
        scheduleReconnect(resourceUserId, "transient", { immediate: true });
      }, DISCONNECTED_RECONNECT_GRACE_MS);
    },
    [scheduleReconnect],
  );

  const shouldReconnectForFrozenPlayback = useCallback(
    (snapshot: WHEPSessionSnapshot): boolean => {
      if (!videoElement) {
        clearFrozenPlaybackState();
        return false;
      }

      if (
        snapshot.status !== "connected" ||
        videoElement.ended ||
        document.visibilityState !== "visible"
      ) {
        clearFrozenPlaybackState();
        return false;
      }

      const now = Date.now();
      const currentTime = videoElement.currentTime;
      const state = frozenPlaybackStateRef.current;
      if (!state) {
        frozenPlaybackStateRef.current = {
          lastCurrentTime: currentTime,
          lastProgressAt: now,
          noStreamSinceAt: snapshot.hasStream ? null : now,
        };
        return false;
      }

      if (!snapshot.hasStream) {
        const noStreamSinceAt = state.noStreamSinceAt ?? now;
        frozenPlaybackStateRef.current = {
          ...state,
          lastCurrentTime: currentTime,
          noStreamSinceAt,
        };
        return now - noStreamSinceAt >= NO_STREAM_RECONNECT_GRACE_MS;
      }

      if (state.noStreamSinceAt !== null) {
        frozenPlaybackStateRef.current = {
          lastCurrentTime: currentTime,
          lastProgressAt: now,
          noStreamSinceAt: null,
        };
        return false;
      }

      if (
        videoElement.paused &&
        videoElement.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      ) {
        frozenPlaybackStateRef.current = {
          lastCurrentTime: currentTime,
          lastProgressAt: now,
          noStreamSinceAt: null,
        };
        return false;
      }

      if (currentTime > state.lastCurrentTime + 0.01) {
        frozenPlaybackStateRef.current = {
          lastCurrentTime: currentTime,
          lastProgressAt: now,
          noStreamSinceAt: null,
        };
        return false;
      }

      frozenPlaybackStateRef.current = {
        ...state,
        lastCurrentTime: currentTime,
        noStreamSinceAt: null,
      };
      return now - state.lastProgressAt >= FROZEN_PLAYBACK_RECONNECT_GRACE_MS;
    },
    [clearFrozenPlaybackState, videoElement],
  );

  const handleAttemptFailure = useCallback(
    (resourceUserId: string, mode: "initial" | "retry", error: Error) => {
      if (targetResourceRef.current !== resourceUserId) {
        return;
      }

      const normalizedError = normalizeError(error);
      const retryFailureKind = classifyRetryFailure(normalizedError);
      if (mode === "initial" && isInitialPlaybackClientError(normalizedError)) {
        if (
          normalizedError instanceof WHEPSessionError &&
          normalizedError.statusCode === 404
        ) {
          scheduleReconnect(resourceUserId, "notFound", { immediate: true });
          return;
        }

        finalizePlayback("error", resourceUserId, normalizedError);
        return;
      }

      if (retryFailureKind === "fatal") {
        finalizePlayback("error", resourceUserId, normalizedError);
        return;
      }

      scheduleReconnect(resourceUserId, retryFailureKind);
    },
    [finalizePlayback, scheduleReconnect],
  );

  const startPlaybackAttempt = useCallback(
    async (
      resourceUserId: string,
      mode: "initial" | "retry",
      loadingToken: number | null = null,
    ) => {
      if (targetResourceRef.current !== resourceUserId) {
        return;
      }

      if (!videoElement) {
        pendingAttemptRef.current = { loadingToken, mode, resourceUserId };
        return;
      }

      pendingAttemptRef.current = null;

      const sessionAttemptId = attemptIdRef.current + 1;
      attemptIdRef.current = sessionAttemptId;
      attemptStartedAtRef.current = Date.now();

      const previousSession = sessionRef.current;
      sessionRef.current = null;
      if (previousSession) {
        void previousSession.dispose({ notifyServer: true });
      }

      let startupPending = true;
      const session = new WHEPSession({
        callbacks: {
          onStreamChange: (nextHasStream) => {
            if (
              attemptIdRef.current !== sessionAttemptId ||
              targetResourceRef.current !== resourceUserId
            ) {
              return;
            }

            setPlaybackState((currentPlaybackState) => ({
              ...currentPlaybackState,
              hasStream: nextHasStream,
            }));
          },
          onStatusChange: (status) => {
            if (
              attemptIdRef.current !== sessionAttemptId ||
              targetResourceRef.current !== resourceUserId
            ) {
              return;
            }

            if (status === "connected") {
              startupPending = false;
              clearDisconnectedReconnectTimer();
              clearFrozenPlaybackState();
              clearPostConnectReconnectTimer();
              clearRetryTimer();
              attemptStartedAtRef.current = null;
              retryAttemptInFlightRef.current = false;
              retryStateRef.current = null;
              setPlaybackState((currentPlaybackState) => ({
                ...currentPlaybackState,
                connectionStatus: "connected",
                message: null,
                phase: "connected",
                retryCount: 0,
              }));
              return;
            }

            if (status === "connecting") {
              clearDisconnectedReconnectTimer();
              clearFrozenPlaybackState();
              if (!startupPending) {
                armPostConnectReconnect(
                  resourceUserId,
                  session,
                  sessionAttemptId,
                );
                return;
              }

              setPlaybackState((currentPlaybackState) => ({
                ...currentPlaybackState,
                connectionStatus: "connecting",
                hasStream: false,
                message: getPhaseMessage(
                  mode === "retry" ? "reconnecting" : "connecting",
                ),
                phase: mode === "retry" ? "reconnecting" : "connecting",
                retryCount: retryStateRef.current?.attemptCount ?? 0,
              }));
              return;
            }

            if (startupPending) {
              return;
            }

            if (status === "disconnected") {
              clearPostConnectReconnectTimer();
              clearFrozenPlaybackState();
              setPlaybackState((currentPlaybackState) => ({
                ...currentPlaybackState,
                connectionStatus: "disconnected",
                hasStream: false,
                message: getPhaseMessage("reconnecting"),
                phase: "reconnecting",
              }));
              armDisconnectedReconnect(resourceUserId, session, sessionAttemptId);
              return;
            }

            clearDisconnectedReconnectTimer();
            clearFrozenPlaybackState();
            clearPostConnectReconnectTimer();
            setPlaybackState((currentPlaybackState) => ({
              ...currentPlaybackState,
              connectionStatus: status,
              hasStream: false,
            }));

            attemptIdRef.current += 1;
            if (sessionRef.current === session) {
              sessionRef.current = null;
            }
            void session.dispose({ notifyServer: true });
            scheduleReconnect(resourceUserId, "transient");
          },
        },
        resourceUserId,
        videoElement,
      });

      sessionRef.current = session;
      setPlaybackState(
        createPlaybackState(
          resourceUserId,
          mode === "retry" ? "reconnecting" : "connecting",
          "connecting",
          retryStateRef.current?.attemptCount ?? 0,
        ),
      );

      try {
        await session.start();
        startupPending = false;
      } catch (error) {
        startupPending = false;
        if (
          attemptIdRef.current !== sessionAttemptId ||
          targetResourceRef.current !== resourceUserId
        ) {
          return;
        }

        if (sessionRef.current === session) {
          sessionRef.current = null;
        }

        retryAttemptInFlightRef.current = false;
        handleAttemptFailure(resourceUserId, mode, normalizeError(error));
      } finally {
        if (
          mode === "initial" &&
          loadingToken !== null &&
          initialLoadTokenRef.current === loadingToken
        ) {
          setIsLoading(false);
        }
      }
    },
    [
      armDisconnectedReconnect,
      armPostConnectReconnect,
      clearDisconnectedReconnectTimer,
      clearFrozenPlaybackState,
      clearPostConnectReconnectTimer,
      clearRetryTimer,
      handleAttemptFailure,
      scheduleReconnect,
      videoElement,
    ],
  );

  useEffect(() => {
    startPlaybackAttemptRef.current = startPlaybackAttempt;
  }, [startPlaybackAttempt]);

  const disconnect = useCallback(() => {
    targetResourceRef.current = null;
    pendingAttemptRef.current = null;
    attemptIdRef.current += 1;
    finalizePlayback("idle", null);
  }, [finalizePlayback]);

  const load = useCallback(
    (resourceUserId: string) => {
      const trimmedResourceUserId = resourceUserId.trim();
      if (trimmedResourceUserId.length === 0) {
        return;
      }

      const loadingToken = initialLoadTokenRef.current + 1;
      initialLoadTokenRef.current = loadingToken;
      targetResourceRef.current = trimmedResourceUserId;
      pendingAttemptRef.current = null;
      clearPostConnectReconnectTimer();
      clearRetryTimer();
      setIsLoading(true);
      retryStateRef.current = null;
      retryAttemptInFlightRef.current = false;
      setPlaybackState(
        createPlaybackState(
          trimmedResourceUserId,
          "connecting",
          "connecting",
          0,
        ),
      );
      void startPlaybackAttempt(trimmedResourceUserId, "initial", loadingToken);
    },
    [clearPostConnectReconnectTimer, clearRetryTimer, startPlaybackAttempt],
  );

  const handleResume = useCallback((options?: { allowConnectingTimeout?: boolean }) => {
    const allowConnectingTimeout = options?.allowConnectingTimeout ?? true;
    const resourceUserId = targetResourceRef.current;
    if (!resourceUserId) {
      return;
    }

    const retryState = retryStateRef.current;
    if (retryState) {
      if (Date.now() >= retryState.deadlineAt) {
        finalizePlayback(
          resolveRetryResolution(retryState.resolutionState),
          resourceUserId,
          retryState.resolutionState.sawNotFound &&
            !retryState.resolutionState.sawError
            ? undefined
            : new Error("WHEP reconnect window expired"),
        );
        return;
      }

      if (retryAttemptInFlightRef.current) {
        return;
      }

      const retryScheduledAt = retryScheduledAtRef.current;
      if (retryScheduledAt !== null && Date.now() < retryScheduledAt) {
        return;
      }

      startRetryAttempt(resourceUserId);
      return;
    }

    const session = sessionRef.current;
    if (!session) {
      scheduleReconnect(resourceUserId, "transient", { immediate: true });
      return;
    }

    const snapshot = session.getSnapshot();
    if (
      snapshot.status === "disconnected" &&
      disconnectedReconnectTimerRef.current !== null
    ) {
      return;
    }

    if (shouldReconnectForFrozenPlayback(snapshot)) {
      attemptIdRef.current += 1;
      sessionRef.current = null;
      void session.dispose({ notifyServer: true });
      scheduleReconnect(resourceUserId, "transient", { immediate: true });
      return;
    }

    if (snapshot.status === "connecting" && snapshot.expectedRemoteTrackCount > 0) {
      armPostConnectReconnect(resourceUserId, session, attemptIdRef.current);
      return;
    }

    const reconnectOptions = allowConnectingTimeout
      ? { connectingStartedAt: attemptStartedAtRef.current }
      : undefined;
    if (shouldReconnectOnResume(snapshot, reconnectOptions)) {
      attemptIdRef.current += 1;
      sessionRef.current = null;
      void session.dispose({ notifyServer: true });
      scheduleReconnect(resourceUserId, "transient", { immediate: true });
    }
  }, [
      armPostConnectReconnect,
      finalizePlayback,
      scheduleReconnect,
      shouldReconnectForFrozenPlayback,
      startRetryAttempt,
    ]);

  useEffect(() => {
    onHandlersChange?.({ load, disconnect });

    return () => {
      onHandlersChange?.(noopWHEPVideoPlayerHandlers);
    };
  }, [disconnect, load, onHandlersChange]);

  useEffect(() => {
    onLoadingChange?.(isLoading);
  }, [isLoading, onLoadingChange]);

  useEffect(() => {
    onPlaybackStateChange?.(playbackState);
    onStatusChange?.(playbackState.connectionStatus);
  }, [onPlaybackStateChange, onStatusChange, playbackState]);

  useEffect(() => {
    if (!videoElement) {
      return;
    }

    const pendingAttempt = pendingAttemptRef.current;
    if (!pendingAttempt) {
      return;
    }

    pendingAttemptRef.current = null;
    void startPlaybackAttempt(
      pendingAttempt.resourceUserId,
      pendingAttempt.mode,
      pendingAttempt.loadingToken,
    );
  }, [startPlaybackAttempt, videoElement]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        handleResume();
      }
    };
    const handlePageShow = () => {
      handleResume();
    };
    const handleFocus = () => {
      handleResume();
    };
    const handleOnline = () => {
      handleResume();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleOnline);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleOnline);
    };
  }, [handleResume]);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      handleResume({ allowConnectingTimeout: false });
    }, SESSION_HEALTH_CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [handleResume]);

  useEffect(() => {
    return () => {
      targetResourceRef.current = null;
      pendingAttemptRef.current = null;
      attemptIdRef.current += 1;
      stopPlayback({ resetState: false });
    };
  }, [stopPlayback]);

  return (
    <section className="rounded-4xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-black/20 backdrop-blur">
      <div className="mb-4">
        <p className="text-sm font-medium tracking-[0.3em] text-cyan-300/80 uppercase">
          Playback
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
          配信映像
        </h2>
      </div>
      <div className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-black/70 shadow-2xl shadow-black/30">
        <div className="absolute inset-x-0 top-0 z-10 h-1 bg-linear-to-r from-cyan-400 via-blue-500 to-emerald-400" />
        <video
          ref={mountVideo}
          className={`aspect-video w-full bg-black object-contain ${playbackState.hasStream ? "opacity-100" : "opacity-0"}`}
          controls={playbackState.hasStream}
          autoPlay
          muted
          playsInline
        />
        {!playbackState.hasStream && (
          <VideoPlaceholder message={getVideoPlaceholderText(playbackState)} />
        )}
      </div>
    </section>
  );
}
