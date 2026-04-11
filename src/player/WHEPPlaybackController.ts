import { WHEPSession, WHEPSessionError } from "./WHEPClient";
import {
  WHEP_SESSION_RECOVERY_GRACE_MS,
  classifyReconnectFailure,
  createReconnectDeadline,
  getReconnectDelayMs,
  shouldRecoverEstablishedSession,
  type WHEPRetryFailureKind,
} from "./whep-reconnect";
import {
  createIdlePlaybackState,
  createPlaybackState,
  getPlaybackPhaseMessage,
  type WHEPPlaybackState,
} from "./whep-playback";

type AttemptMode = "initial" | "retry";

type PendingStart = {
  loadingToken: number | null;
  mode: AttemptMode;
  resourceUserId: string;
};

type ReconnectState = {
  attemptCount: number;
  deadlineAt: number;
  sawError: boolean;
  sawNotFound: boolean;
};

export type WHEPPlaybackControllerSnapshot = {
  isLoading: boolean;
  playbackState: WHEPPlaybackState;
};

type WHEPPlaybackControllerOptions = {
  onError?: (error: Error) => void;
};

type SnapshotSubscriber = (
  snapshot: WHEPPlaybackControllerSnapshot,
) => void;

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function createReconnectState(now = Date.now()): ReconnectState {
  return {
    attemptCount: 0,
    deadlineAt: createReconnectDeadline(now),
    sawError: false,
    sawNotFound: false,
  };
}

function applyReconnectFailure(
  state: ReconnectState,
  failureKind: WHEPRetryFailureKind,
): ReconnectState {
  switch (failureKind) {
    case "error":
    case "fatal":
      return { ...state, sawError: true };
    case "notFound":
      return { ...state, sawNotFound: true };
    case "transient":
      return state;
    default:
      return failureKind satisfies never;
  }
}

function resolveReconnectPhase(state: ReconnectState): "ended" | "error" {
  return state.sawNotFound && !state.sawError ? "ended" : "error";
}

export class WHEPPlaybackController {
  private attemptId = 0;
  private disposed = false;
  private initialLoadToken = 0;
  private onError: ((error: Error) => void) | undefined;
  private pendingStart: PendingStart | null = null;
  private reconnectState: ReconnectState | null = null;
  private reconnectTimerId: number | null = null;
  private recoveryTimerId: number | null = null;
  private session: WHEPSession | null = null;
  private snapshotSubscriber: SnapshotSubscriber | null = null;
  private snapshot: WHEPPlaybackControllerSnapshot = {
    isLoading: false,
    playbackState: createIdlePlaybackState(),
  };
  private targetResourceUserId: string | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private wasConnected = false;

  constructor(options: WHEPPlaybackControllerOptions = {}) {
    this.onError = options.onError;
  }

  attachVideoElement(videoElement: HTMLVideoElement | null): void {
    if (this.disposed) {
      return;
    }

    this.videoElement = videoElement;

    if (!videoElement || !this.pendingStart) {
      return;
    }

    const pendingStart = this.pendingStart;
    this.pendingStart = null;
    void this.startAttempt(
      pendingStart.resourceUserId,
      pendingStart.mode,
      pendingStart.loadingToken,
    );
  }

  disconnect(): void {
    this.finalizePlayback("idle", null);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    const subscriber = this.snapshotSubscriber;
    if (subscriber) {
      this.unsetSnapshotSubscriber(subscriber);
    }
    this.attemptId += 1;
    this.initialLoadToken += 1;
    this.clearActiveRuntime();
    this.targetResourceUserId = null;
    this.videoElement = null;
    this.snapshot = {
      ...this.snapshot,
      isLoading: false,
    };
  }

  load(resourceUserId: string): void {
    const trimmedResourceUserId = resourceUserId.trim();
    if (trimmedResourceUserId.length === 0 || this.disposed) {
      return;
    }

    this.stopRuntime({ clearTarget: false, emit: false });
    this.targetResourceUserId = trimmedResourceUserId;

    const loadingToken = this.initialLoadToken + 1;
    this.initialLoadToken = loadingToken;
    this.updateSnapshot({
      isLoading: true,
      playbackState: createPlaybackState(
        trimmedResourceUserId,
        "connecting",
        "connecting",
        0,
      ),
    });

    void this.startAttempt(trimmedResourceUserId, "initial", loadingToken);
  }

  setSnapshotSubscriber(subscriber: SnapshotSubscriber): void {
    this.snapshotSubscriber = subscriber;
    subscriber(this.snapshot);
  }

  unsetSnapshotSubscriber(subscriber: SnapshotSubscriber): void {
    if (this.snapshotSubscriber !== subscriber) {
      return;
    }

    this.snapshotSubscriber = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId === null) {
      return;
    }

    window.clearTimeout(this.reconnectTimerId);
    this.reconnectTimerId = null;
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimerId === null) {
      return;
    }

    window.clearTimeout(this.recoveryTimerId);
    this.recoveryTimerId = null;
  }

  private clearRetryState(): void {
    this.clearReconnectTimer();
    this.reconnectState = null;
  }

  private clearActiveRuntime(): void {
    this.pendingStart = null;
    this.wasConnected = false;
    this.clearRecoveryTimer();
    this.clearRetryState();
    this.disposeSession();
  }

  private disposeSession(): void {
    const session = this.session;
    this.session = null;

    if (session) {
      void session.dispose({ notifyServer: true });
    }
  }

  private emit(): void {
    if (this.disposed) {
      return;
    }

    this.snapshotSubscriber?.(this.snapshot);
  }

  private finalizePlayback(
    phase: "idle" | "ended" | "error",
    resourceUserId: string | null,
    error?: Error,
  ): void {
    this.stopRuntime({ clearTarget: true, emit: false });

    if (phase === "idle") {
      this.updateSnapshot({
        isLoading: false,
        playbackState: createIdlePlaybackState(),
      });
      return;
    }

    this.updateSnapshot({
      isLoading: false,
      playbackState: {
        connectionStatus: phase === "ended" ? "disconnected" : "failed",
        hasStream: false,
        message: getPlaybackPhaseMessage(phase),
        phase,
        resourceUserId,
        retryCount: 0,
      },
    });

    if (phase === "error" && error) {
      this.onError?.(error);
    }
  }

  private finishReconnectWindow(
    resourceUserId: string,
    reconnectState: ReconnectState,
  ): void {
    const phase = resolveReconnectPhase(reconnectState);
    this.finalizePlayback(
      phase,
      resourceUserId,
      phase === "error" ? new Error("WHEP reconnect window expired") : undefined,
    );
  }

  private markConnected(resourceUserId: string, session: WHEPSession): void {
    this.wasConnected = true;
    this.clearRecoveryTimer();
    this.clearRetryState();

    const sessionSnapshot = session.getSnapshot();
    this.updatePlaybackState({
      connectionStatus: "connected",
      hasStream: sessionSnapshot.hasStream,
      message: null,
      phase: "connected",
      resourceUserId,
      retryCount: 0,
    });
  }

  private scheduleReconnect(
    resourceUserId: string,
    failureKind: WHEPRetryFailureKind,
    options?: { immediate?: boolean },
  ): void {
    if (
      this.disposed ||
      this.targetResourceUserId !== resourceUserId ||
      !this.wasConnected
    ) {
      return;
    }

    this.clearRecoveryTimer();

    const now = Date.now();
    const reconnectState = applyReconnectFailure(
      this.reconnectState ?? createReconnectState(now),
      failureKind,
    );
    this.reconnectState = reconnectState;

    this.updatePlaybackState({
      ...this.snapshot.playbackState,
      connectionStatus: "connecting",
      hasStream: false,
      message: getPlaybackPhaseMessage("reconnecting"),
      phase: "reconnecting",
      resourceUserId,
      retryCount: reconnectState.attemptCount,
    });

    if (now >= reconnectState.deadlineAt) {
      this.finishReconnectWindow(resourceUserId, reconnectState);
      return;
    }

    if (options?.immediate) {
      this.startRetryAttempt(resourceUserId);
      return;
    }

    if (this.reconnectTimerId !== null) {
      return;
    }

    this.reconnectTimerId = window.setTimeout(() => {
      this.startRetryAttempt(resourceUserId);
    }, getReconnectDelayMs(reconnectState.attemptCount, reconnectState.deadlineAt - now));
  }

  private startRetryAttempt(resourceUserId: string): void {
    const reconnectState = this.reconnectState;
    if (
      !reconnectState ||
      this.disposed ||
      this.targetResourceUserId !== resourceUserId
    ) {
      return;
    }

    if (Date.now() >= reconnectState.deadlineAt) {
      this.finishReconnectWindow(resourceUserId, reconnectState);
      return;
    }

    this.clearReconnectTimer();
    this.reconnectState = {
      ...reconnectState,
      attemptCount: reconnectState.attemptCount + 1,
    };

    this.updatePlaybackState({
      ...this.snapshot.playbackState,
      connectionStatus: "connecting",
      hasStream: false,
      message: getPlaybackPhaseMessage("reconnecting"),
      phase: "reconnecting",
      resourceUserId,
      retryCount: reconnectState.attemptCount + 1,
    });

    void this.startAttempt(resourceUserId, "retry");
  }

  private startRecoveryTimer(
    resourceUserId: string,
    session: WHEPSession,
    sessionAttemptId: number,
  ): void {
    if (
      this.disposed ||
      !this.wasConnected ||
      this.reconnectState !== null ||
      this.recoveryTimerId !== null
    ) {
      return;
    }

    const sessionSnapshot = session.getSnapshot();
    if (!shouldRecoverEstablishedSession(sessionSnapshot)) {
      this.clearRecoveryTimer();
      return;
    }

    this.updatePlaybackState({
      ...this.snapshot.playbackState,
      connectionStatus: sessionSnapshot.status,
      hasStream: false,
      message: getPlaybackPhaseMessage("reconnecting"),
      phase: "reconnecting",
      resourceUserId,
    });

    this.recoveryTimerId = window.setTimeout(() => {
      this.recoveryTimerId = null;

      if (
        this.disposed ||
        this.attemptId !== sessionAttemptId ||
        this.targetResourceUserId !== resourceUserId ||
        this.session !== session ||
        !shouldRecoverEstablishedSession(session.getSnapshot())
      ) {
        return;
      }

      this.session = null;
      void session.dispose({ notifyServer: true });
      this.scheduleReconnect(resourceUserId, "transient", { immediate: true });
    }, WHEP_SESSION_RECOVERY_GRACE_MS);
  }

  private stopRuntime(options?: { clearTarget?: boolean; emit?: boolean }): void {
    this.attemptId += 1;
    this.initialLoadToken += 1;
    this.clearActiveRuntime();

    if (options?.clearTarget !== false) {
      this.targetResourceUserId = null;
    }

    this.snapshot = {
      ...this.snapshot,
      isLoading: false,
    };

    if (options?.emit !== false) {
      this.emit();
    }
  }

  private async startAttempt(
    resourceUserId: string,
    mode: AttemptMode,
    loadingToken: number | null = null,
  ): Promise<void> {
    if (
      this.disposed ||
      this.targetResourceUserId !== resourceUserId
    ) {
      return;
    }

    if (!this.videoElement) {
      this.pendingStart = { loadingToken, mode, resourceUserId };
      return;
    }

    this.pendingStart = null;
    this.clearRecoveryTimer();
    this.clearReconnectTimer();

    const sessionAttemptId = this.attemptId + 1;
    this.attemptId = sessionAttemptId;
    this.disposeSession();

    const phase = mode === "retry" ? "reconnecting" : "connecting";
    const session = new WHEPSession({
      callbacks: {
        onStatusChange: (status) => {
          if (
            this.disposed ||
            this.attemptId !== sessionAttemptId ||
            this.targetResourceUserId !== resourceUserId
          ) {
            return;
          }

          if (status === "connected") {
            this.markConnected(resourceUserId, session);
            return;
          }

          if (!this.wasConnected) {
            this.updatePlaybackState({
              ...this.snapshot.playbackState,
              connectionStatus: status,
              message: getPlaybackPhaseMessage("connecting"),
              phase: "connecting",
              resourceUserId,
            });
            return;
          }

          this.startRecoveryTimer(resourceUserId, session, sessionAttemptId);
        },
        onStreamChange: (hasStream) => {
          if (
            this.disposed ||
            this.attemptId !== sessionAttemptId ||
            this.targetResourceUserId !== resourceUserId
          ) {
            return;
          }

          const sessionSnapshot = session.getSnapshot();
          if (
            sessionSnapshot.status === "connected" &&
            !shouldRecoverEstablishedSession(sessionSnapshot)
          ) {
            this.clearRecoveryTimer();
            this.updatePlaybackState({
              connectionStatus: "connected",
              hasStream,
              message: null,
              phase: "connected",
              resourceUserId,
              retryCount: 0,
            });
            return;
          }

          this.updatePlaybackState({
            ...this.snapshot.playbackState,
            hasStream,
          });

          if (this.wasConnected) {
            this.startRecoveryTimer(resourceUserId, session, sessionAttemptId);
          }
        },
      },
      resourceUserId,
      videoElement: this.videoElement,
    });

    this.session = session;
    this.updatePlaybackState(
      createPlaybackState(
        resourceUserId,
        phase,
        "connecting",
        this.reconnectState?.attemptCount ?? 0,
      ),
    );

    try {
      await session.start();

      if (
        this.attemptId !== sessionAttemptId ||
        this.targetResourceUserId !== resourceUserId
      ) {
        return;
      }

      if (session.getSnapshot().status === "connected") {
        this.markConnected(resourceUserId, session);
        return;
      }

      if (mode === "retry" && this.wasConnected) {
        this.startRecoveryTimer(resourceUserId, session, sessionAttemptId);
      }
    } catch (error) {
      if (
        this.attemptId !== sessionAttemptId ||
        this.targetResourceUserId !== resourceUserId
      ) {
        return;
      }

      if (this.session === session) {
        this.session = null;
      }

      const normalizedError = normalizeError(error);
      if (mode === "initial") {
        if (
          normalizedError instanceof WHEPSessionError &&
          normalizedError.statusCode === 404
        ) {
          this.finalizePlayback("ended", resourceUserId);
          return;
        }

        this.finalizePlayback("error", resourceUserId, normalizedError);
        return;
      }

      const failureKind = classifyReconnectFailure(normalizedError);
      if (failureKind === "fatal") {
        this.finalizePlayback("error", resourceUserId, normalizedError);
        return;
      }

      this.scheduleReconnect(resourceUserId, failureKind);
    } finally {
      if (
        mode === "initial" &&
        loadingToken !== null &&
        this.initialLoadToken === loadingToken
      ) {
        this.updateSnapshot({
          isLoading: false,
        });
      }
    }
  }

  private updatePlaybackState(playbackState: WHEPPlaybackState): void {
    this.updateSnapshot({ playbackState });
  }

  private updateSnapshot(
    nextSnapshot: Partial<WHEPPlaybackControllerSnapshot>,
  ): void {
    this.snapshot = {
      ...this.snapshot,
      ...nextSnapshot,
    };
    this.emit();
  }
}
