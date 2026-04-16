import { WHEPSession, WHEPSessionError } from "./WHEPClient";
import {
  type WHEPReconnectAttemptMode,
  WHEP_PLAYBACK_STALL_GRACE_MS,
  WHEP_RECONNECT_WINDOW_MS,
  WHEP_RETRY_PLAYBACK_START_GRACE_MS,
  WHEP_SESSION_RECOVERY_GRACE_MS,
  getReconnectDelayMs,
  resolveReconnectDisposition,
  shouldReconnectForPlaybackStall,
  shouldRecoverEstablishedSession,
} from "./whep-reconnect";
import {
  createDefaultPlaybackState,
  createPlaybackState,
  type WHEPPlaybackState,
} from "./whep-playback";

type AttemptMode = WHEPReconnectAttemptMode;

type PendingAttempt = {
  attemptId: number;
  mode: AttemptMode;
};

type PlaybackMonitorVideoElement = HTMLVideoElement & {
  cancelVideoFrameCallback?: (handle: number) => void;
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameCallbackMetadata) => void,
  ) => number;
};

type PlaybackMonitorState = {
  attemptId: number;
  lastCurrentTime: number;
  mode: AttemptMode;
  resourceUserId: string;
  sawPlaybackProgress: boolean;
  session: WHEPSession;
  timeoutId: number | null;
  videoElement: PlaybackMonitorVideoElement;
  videoFrameRequestId: number | null;
  cleanup: () => void;
};

export type WHEPPlaybackControllerSnapshot = {
  isLoading: boolean;
  playbackState: WHEPPlaybackState;
};

type SnapshotSubscriber = (snapshot: WHEPPlaybackControllerSnapshot) => void;

export function createDefaultSnapshot(): WHEPPlaybackControllerSnapshot {
  return {
    isLoading: false,
    playbackState: createDefaultPlaybackState(),
  };
}

function isNotFoundError(error: Error): boolean {
  return error instanceof WHEPSessionError && error.isNotFound();
}

function createConnectedPlaybackState(
  resourceUserId: string,
  hasStream: boolean,
): WHEPPlaybackState {
  return {
    connectionStatus: "connected",
    hasStream,
    phase: "connected",
    resourceUserId,
    retryCount: 0,
  };
}

function createTerminalPlaybackState(
  phase: "ended" | "error",
  resourceUserId: string,
): WHEPPlaybackState {
  return {
    connectionStatus: phase === "ended" ? "disconnected" : "failed",
    hasStream: false,
    phase,
    resourceUserId,
    retryCount: 0,
  };
}

export class WHEPPlaybackController {
  private attemptId = 0;
  private disposed = false;
  private loadingAttemptId: number | null = null;
  private pendingAttempt: PendingAttempt | null = null;
  private playbackMonitor: PlaybackMonitorState | null = null;
  private reconnectDeadlineAt: number | null = null;
  private reconnectSawNotFound = false;
  private reconnectTimerId: number | null = null;
  private recoveryTimerId: number | null = null;
  private retryCount = 0;
  private session: WHEPSession | null = null;
  private snapshot = createDefaultSnapshot();
  private snapshotSubscriber: SnapshotSubscriber | null = null;
  private targetResourceUserId: string | null = null;
  private videoElement: PlaybackMonitorVideoElement | null = null;

  attachVideoElement(videoElement: HTMLVideoElement | null): void {
    if (this.disposed) {
      return;
    }

    this.videoElement = videoElement;

    if (!videoElement || this.pendingAttempt === null) {
      return;
    }

    const pendingAttempt = this.pendingAttempt;
    this.pendingAttempt = null;
    void this.startAttempt(pendingAttempt);
  }

  load(resourceUserId: string): void {
    const trimmedResourceUserId = resourceUserId.trim();
    if (trimmedResourceUserId.length === 0 || this.disposed) {
      return;
    }

    this.resetRuntime(false);
    this.targetResourceUserId = trimmedResourceUserId;

    const attemptId = this.bumpAttemptId();
    this.loadingAttemptId = attemptId;
    this.updateSnapshot({
      isLoading: true,
      playbackState: createPlaybackState(
        trimmedResourceUserId,
        "connecting",
        "connecting",
        0,
      ),
    });

    void this.startAttempt({ attemptId, mode: "initial" });
  }

  disconnect(): void {
    this.resetRuntime(true);
    this.replaceSnapshot(createDefaultSnapshot());
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.snapshotSubscriber = null;
    this.resetRuntime(true);
    this.videoElement = null;
  }

  setSnapshotSubscriber(subscriber: SnapshotSubscriber): void {
    this.snapshotSubscriber = subscriber;
    subscriber(this.snapshot);
  }

  unsetSnapshotSubscriber(subscriber: SnapshotSubscriber): void {
    if (this.snapshotSubscriber === subscriber) {
      this.snapshotSubscriber = null;
    }
  }

  private bumpAttemptId(): number {
    this.attemptId += 1;
    return this.attemptId;
  }

  private isActiveAttempt(attemptId: number): boolean {
    return !this.disposed && this.attemptId === attemptId;
  }

  private isActiveSession(attemptId: number, session: WHEPSession): boolean {
    return this.isActiveAttempt(attemptId) && this.session === session;
  }

  private canReconnect(): boolean {
    return (
      this.targetResourceUserId !== null &&
      (this.snapshot.playbackState.phase === "connected" ||
        this.snapshot.playbackState.phase === "reconnecting")
    );
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimerId !== null) {
      window.clearTimeout(this.reconnectTimerId);
      this.reconnectTimerId = null;
    }
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimerId !== null) {
      window.clearTimeout(this.recoveryTimerId);
      this.recoveryTimerId = null;
    }
  }

  private clearReconnectState(): void {
    this.clearReconnectTimer();
    this.reconnectDeadlineAt = null;
    this.reconnectSawNotFound = false;
    this.retryCount = 0;
  }

  private clearPlaybackMonitor(): void {
    const playbackMonitor = this.playbackMonitor;
    if (playbackMonitor === null) {
      return;
    }

    if (playbackMonitor.timeoutId !== null) {
      window.clearTimeout(playbackMonitor.timeoutId);
    }
    if (playbackMonitor.videoFrameRequestId !== null) {
      playbackMonitor.videoElement.cancelVideoFrameCallback(
        playbackMonitor.videoFrameRequestId,
      );
    }
    playbackMonitor.cleanup();
    this.playbackMonitor = null;
  }

  private disposeSession(): void {
    const session = this.session;
    this.session = null;
    if (session) {
      void session.dispose({ notifyServer: true });
    }
  }

  private emit(): void {
    if (!this.disposed) {
      this.snapshotSubscriber?.(this.snapshot);
    }
  }

  private replaceSnapshot(snapshot: WHEPPlaybackControllerSnapshot): void {
    this.snapshot = snapshot;
    this.emit();
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

  private updatePlaybackState(playbackState: WHEPPlaybackState): void {
    this.updateSnapshot({ playbackState });
  }

  private resetRuntime(clearTarget: boolean): void {
    this.bumpAttemptId();
    this.pendingAttempt = null;
    this.loadingAttemptId = null;
    this.clearPlaybackMonitor();
    this.clearRecoveryTimer();
    this.clearReconnectState();
    this.disposeSession();

    if (clearTarget) {
      this.targetResourceUserId = null;
    }

    this.snapshot = {
      ...this.snapshot,
      isLoading: false,
    };
  }

  private finalizePlayback(
    phase: "ended" | "error",
    resourceUserId: string,
    error?: Error,
  ): void {
    this.resetRuntime(true);
    this.updateSnapshot({
      isLoading: false,
      playbackState: createTerminalPlaybackState(phase, resourceUserId),
    });

    if (phase === "error" && error) {
      console.error("WHEP playback failed:", error);
    }
  }

  private handleAttemptFailure(
    error: Error,
    mode: AttemptMode,
    resourceUserId: string,
  ): void {
    if (mode === "initial") {
      this.finalizePlayback(
        isNotFoundError(error) ? "ended" : "error",
        resourceUserId,
        error,
      );
      return;
    }

    if (isNotFoundError(error)) {
      this.reconnectSawNotFound = true;
      this.queueReconnect();
      return;
    }

    switch (resolveReconnectDisposition(error)) {
      case "ended":
        this.finalizePlayback("ended", resourceUserId);
        return;
      case "error":
        this.finalizePlayback("error", resourceUserId, error);
        return;
      case "retry":
        this.queueReconnect();
        return;
    }
  }

  private handleConnected(
    resourceUserId: string,
    session: WHEPSession,
    mode: AttemptMode,
  ): void {
    const currentAttemptId = this.attemptId;
    this.clearRecoveryTimer();
    this.clearReconnectState();
    this.updatePlaybackState(
      createConnectedPlaybackState(
        resourceUserId,
        session.getSnapshot().hasStream,
      ),
    );
    this.startPlaybackMonitor(currentAttemptId, session, resourceUserId, mode);
  }

  private updateRecoveringPlaybackState(
    connectionStatus: "disconnected" | "failed",
  ): void {
    const resourceUserId = this.targetResourceUserId;
    if (resourceUserId === null) {
      return;
    }

    this.updatePlaybackState({
      connectionStatus,
      hasStream: false,
      phase: "reconnecting",
      resourceUserId,
      retryCount: this.retryCount,
    });
  }

  private queueReconnect(options?: { immediate?: boolean }): void {
    if (!this.canReconnect() || this.targetResourceUserId === null) {
      return;
    }

    this.clearPlaybackMonitor();
    this.clearRecoveryTimer();

    const resourceUserId = this.targetResourceUserId;
    const now = Date.now();
    if (this.reconnectDeadlineAt === null) {
      this.reconnectDeadlineAt = now + WHEP_RECONNECT_WINDOW_MS;
      this.retryCount = 0;
    }

    if (now >= this.reconnectDeadlineAt) {
      this.finalizePlayback(
        this.reconnectSawNotFound ? "ended" : "error",
        resourceUserId,
        this.reconnectSawNotFound
          ? undefined
          : new Error("WHEP reconnect window expired"),
      );
      return;
    }

    this.updatePlaybackState({
      connectionStatus: "connecting",
      hasStream: false,
      phase: "reconnecting",
      resourceUserId,
      retryCount: this.retryCount,
    });

    if (this.reconnectTimerId !== null) {
      return;
    }

    const delayMs = options?.immediate
      ? 0
      : getReconnectDelayMs(this.retryCount, this.reconnectDeadlineAt - now);
    this.reconnectTimerId = window.setTimeout(() => {
      this.reconnectTimerId = null;

      if (!this.canReconnect() || this.targetResourceUserId === null) {
        return;
      }

      const reconnectDeadlineAt = this.reconnectDeadlineAt;
      if (reconnectDeadlineAt === null || Date.now() >= reconnectDeadlineAt) {
        this.finalizePlayback(
          this.reconnectSawNotFound ? "ended" : "error",
          resourceUserId,
          this.reconnectSawNotFound
            ? undefined
            : new Error("WHEP reconnect window expired"),
        );
        return;
      }

      this.retryCount += 1;
      void this.startAttempt({
        attemptId: this.bumpAttemptId(),
        mode: "retry",
      });
    }, delayMs);
  }

  private startRecoveryTimer(attemptId: number, session: WHEPSession): void {
    if (
      !this.isActiveSession(attemptId, session) ||
      this.recoveryTimerId !== null ||
      this.reconnectTimerId !== null
    ) {
      return;
    }

    const sessionSnapshot = session.getSnapshot();
    if (!shouldRecoverEstablishedSession(sessionSnapshot)) {
      this.clearRecoveryTimer();
      return;
    }
    if (
      sessionSnapshot.status !== "disconnected" &&
      sessionSnapshot.status !== "failed"
    ) {
      this.clearRecoveryTimer();
      return;
    }

    this.clearPlaybackMonitor();
    this.updateRecoveringPlaybackState(sessionSnapshot.status);
    this.recoveryTimerId = window.setTimeout(() => {
      this.recoveryTimerId = null;

      if (!this.isActiveSession(attemptId, session)) {
        return;
      }

      if (!shouldRecoverEstablishedSession(session.getSnapshot())) {
        return;
      }

      this.disposeSession();
      this.queueReconnect({ immediate: true });
    }, WHEP_SESSION_RECOVERY_GRACE_MS);
  }

  private startPlaybackMonitor(
    attemptId: number,
    session: WHEPSession,
    resourceUserId: string,
    mode: AttemptMode,
  ): void {
    if (
      !this.isActiveSession(attemptId, session) ||
      this.videoElement === null
    ) {
      return;
    }

    this.clearPlaybackMonitor();

    const videoElement = this.videoElement;
    const currentTime = videoElement.currentTime;
    const sawPlaybackProgress = Number.isFinite(currentTime) && currentTime > 0;
    const playbackMonitor: PlaybackMonitorState = {
      attemptId,
      lastCurrentTime: currentTime,
      mode,
      resourceUserId,
      sawPlaybackProgress,
      session,
      timeoutId: null,
      videoElement,
      videoFrameRequestId: null,
      cleanup: () => {},
    };

    const armWatchdog = () => {
      if (this.playbackMonitor !== playbackMonitor) {
        return;
      }

      if (playbackMonitor.timeoutId !== null) {
        window.clearTimeout(playbackMonitor.timeoutId);
        playbackMonitor.timeoutId = null;
      }

      if (
        !playbackMonitor.sawPlaybackProgress &&
        playbackMonitor.mode === "initial"
      ) {
        return;
      }

      const timeoutMs = playbackMonitor.sawPlaybackProgress
        ? WHEP_PLAYBACK_STALL_GRACE_MS
        : WHEP_RETRY_PLAYBACK_START_GRACE_MS;
      playbackMonitor.timeoutId = window.setTimeout(() => {
        playbackMonitor.timeoutId = null;

        if (
          this.playbackMonitor !== playbackMonitor ||
          !this.isActiveSession(attemptId, session)
        ) {
          return;
        }

        if (
          document.visibilityState !== "visible" ||
          videoElement.paused ||
          !Number.isFinite(videoElement.currentTime)
        ) {
          armWatchdog();
          return;
        }

        if (videoElement.currentTime > playbackMonitor.lastCurrentTime + 0.05) {
          markPlaybackProgress(videoElement.currentTime);
          return;
        }

        if (
          !shouldReconnectForPlaybackStall(
            playbackMonitor.mode,
            playbackMonitor.sawPlaybackProgress,
            timeoutMs,
          )
        ) {
          armWatchdog();
          return;
        }

        this.clearPlaybackMonitor();
        this.updateRecoveringPlaybackState("disconnected");
        this.disposeSession();
        this.queueReconnect({ immediate: true });
      }, timeoutMs);
    };

    const markPlaybackProgress = (nextCurrentTime: number) => {
      if (
        this.playbackMonitor !== playbackMonitor ||
        !Number.isFinite(nextCurrentTime)
      ) {
        return;
      }

      if (
        nextCurrentTime > playbackMonitor.lastCurrentTime + 0.05 ||
        (!playbackMonitor.sawPlaybackProgress && nextCurrentTime > 0)
      ) {
        playbackMonitor.sawPlaybackProgress = true;
      }

      playbackMonitor.lastCurrentTime = nextCurrentTime;

      if (
        this.snapshot.playbackState.phase !== "connected" ||
        !this.snapshot.playbackState.hasStream
      ) {
        this.updatePlaybackState(
          createConnectedPlaybackState(playbackMonitor.resourceUserId, true),
        );
      }

      armWatchdog();
    };

    const handleTimeUpdate = () => {
      markPlaybackProgress(videoElement.currentTime);
    };
    const handlePlaying = () => {
      markPlaybackProgress(videoElement.currentTime);
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        armWatchdog();
      } else if (playbackMonitor.timeoutId !== null) {
        window.clearTimeout(playbackMonitor.timeoutId);
        playbackMonitor.timeoutId = null;
      }
    };
    const scheduleVideoFrameCallback = () => {
      if (
        this.playbackMonitor !== playbackMonitor ||
        typeof videoElement.requestVideoFrameCallback !== "function"
      ) {
        return;
      }

      playbackMonitor.videoFrameRequestId =
        videoElement.requestVideoFrameCallback((_now, metadata) => {
          playbackMonitor.videoFrameRequestId = null;

          if (this.playbackMonitor !== playbackMonitor) {
            return;
          }

          markPlaybackProgress(
            Number.isFinite(metadata.mediaTime)
              ? metadata.mediaTime
              : videoElement.currentTime,
          );
          scheduleVideoFrameCallback();
        });
    };

    videoElement.addEventListener("timeupdate", handleTimeUpdate);
    videoElement.addEventListener("playing", handlePlaying);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    playbackMonitor.cleanup = () => {
      videoElement.removeEventListener("timeupdate", handleTimeUpdate);
      videoElement.removeEventListener("playing", handlePlaying);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };

    this.playbackMonitor = playbackMonitor;
    armWatchdog();
    scheduleVideoFrameCallback();
  }

  private async startAttempt({
    attemptId,
    mode,
  }: PendingAttempt): Promise<void> {
    if (
      !this.isActiveAttempt(attemptId) ||
      this.targetResourceUserId === null
    ) {
      return;
    }

    if (this.videoElement === null) {
      this.pendingAttempt = { attemptId, mode };
      return;
    }

    const resourceUserId = this.targetResourceUserId;
    const phase = mode === "retry" ? "reconnecting" : "connecting";
    let sessionWasConnected = false;

    this.pendingAttempt = null;
    this.clearPlaybackMonitor();
    this.clearRecoveryTimer();
    this.clearReconnectTimer();
    this.disposeSession();

    const session = new WHEPSession({
      callbacks: {
        onStatusChange: (status) => {
          if (!this.isActiveSession(attemptId, session)) {
            return;
          }

          if (status === "connected") {
            sessionWasConnected = true;
            this.handleConnected(resourceUserId, session, mode);
            return;
          }

          if (!sessionWasConnected) {
            this.updatePlaybackState(
              createPlaybackState(
                resourceUserId,
                phase,
                status,
                this.retryCount,
              ),
            );
            return;
          }

          this.startRecoveryTimer(attemptId, session);
        },
        onStreamChange: (hasStream) => {
          if (
            !this.isActiveSession(attemptId, session) ||
            !sessionWasConnected ||
            session.getSnapshot().status !== "connected"
          ) {
            return;
          }

          this.clearRecoveryTimer();
          this.updatePlaybackState(
            createConnectedPlaybackState(resourceUserId, hasStream),
          );
        },
      },
      resourceUserId,
      videoElement: this.videoElement,
    });

    this.session = session;
    this.updatePlaybackState(
      createPlaybackState(resourceUserId, phase, "connecting", this.retryCount),
    );

    try {
      const startResult = await session.start();

      if (!this.isActiveSession(attemptId, session)) {
        return;
      }

      if (startResult.isErr()) {
        if (this.session === session) {
          this.session = null;
        }

        this.handleAttemptFailure(startResult.error, mode, resourceUserId);
        return;
      }

      if (session.getSnapshot().status === "connected") {
        sessionWasConnected = true;
        this.handleConnected(resourceUserId, session, mode);
      }
    } finally {
      if (mode === "initial" && this.loadingAttemptId === attemptId) {
        this.loadingAttemptId = null;
        this.updateSnapshot({ isLoading: false });
      }
    }
  }
}
