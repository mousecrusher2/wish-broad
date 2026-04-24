import {
  WHEPSession,
  WHEPSessionError,
  type WHEPInboundReceiverStat,
} from "./WHEPClient";
import {
  type WHEPReconnectAttemptMode,
  WHEP_RECONNECT_WINDOW_MS,
  WHEP_SESSION_RECOVERY_GRACE_MS,
  WHEP_TRACK_DISCOVERY_GRACE_MS,
  getReconnectDelayMs,
  resolveReconnectDisposition,
  shouldReconnectForPlaybackStall,
  shouldReconnectForTrackDiscoveryTimeout,
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

type PlaybackMonitorState = {
  attemptId: number;
  discoveryTimeoutId: number | null;
  expectedTrackCount: number;
  intervalId: number | null;
  lastBytesReceivedByReceiver: Map<string, number>;
  requiredReceiverIds: string[] | null;
  receiverStalledForMs: Map<string, number>;
  resourceUserId: string;
  session: WHEPSession;
  sync: () => void;
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
  private videoElement: HTMLVideoElement | null = null;

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

    if (playbackMonitor.intervalId !== null) {
      window.clearInterval(playbackMonitor.intervalId);
    }
    if (playbackMonitor.discoveryTimeoutId !== null) {
      window.clearTimeout(playbackMonitor.discoveryTimeoutId);
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

  private handleConnected(resourceUserId: string, session: WHEPSession): void {
    const currentAttemptId = this.attemptId;
    this.clearRecoveryTimer();
    this.clearReconnectState();
    this.updatePlaybackState(
      createConnectedPlaybackState(
        resourceUserId,
        session.getSnapshot().hasStream,
      ),
    );
    this.startPlaybackMonitor(currentAttemptId, session, resourceUserId);
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
  ): void {
    if (!this.isActiveSession(attemptId, session)) {
      return;
    }

    this.clearPlaybackMonitor();

    const playbackMonitor: PlaybackMonitorState = {
      attemptId,
      discoveryTimeoutId: null,
      expectedTrackCount: Math.max(
        1,
        session.getSnapshot().expectedRemoteTrackCount,
      ),
      intervalId: null,
      lastBytesReceivedByReceiver: new Map(),
      requiredReceiverIds: null,
      receiverStalledForMs: new Map(),
      resourceUserId,
      session,
      sync: () => {},
      cleanup: () => {},
    };

    // The Worker cannot continuously poll Calls for all sessions. Let the active
    // viewer detect missing tracks or stalled RTP and reconnect this one stream.
    const stopInterval = () => {
      if (playbackMonitor.intervalId !== null) {
        window.clearInterval(playbackMonitor.intervalId);
        playbackMonitor.intervalId = null;
      }
    };

    const clearDiscoveryTimeout = () => {
      if (playbackMonitor.discoveryTimeoutId !== null) {
        window.clearTimeout(playbackMonitor.discoveryTimeoutId);
        playbackMonitor.discoveryTimeoutId = null;
      }
    };

    let pollInFlight = false;

    const startInterval = () => {
      if (
        this.playbackMonitor !== playbackMonitor ||
        playbackMonitor.intervalId !== null
      ) {
        return;
      }

      playbackMonitor.intervalId = window.setInterval(tick, 1_000);
    };

    const syncMonitor = () => {
      if (this.playbackMonitor !== playbackMonitor) {
        return;
      }

      const shouldPoll = document.visibilityState === "visible";

      if (!shouldPoll) {
        stopInterval();
        clearDiscoveryTimeout();
        return;
      }

      startInterval();

      if (
        playbackMonitor.requiredReceiverIds === null &&
        playbackMonitor.discoveryTimeoutId === null
      ) {
        playbackMonitor.discoveryTimeoutId = window.setTimeout(() => {
          playbackMonitor.discoveryTimeoutId = null;

          if (
            this.playbackMonitor !== playbackMonitor ||
            !this.isActiveSession(attemptId, session) ||
            playbackMonitor.requiredReceiverIds !== null
          ) {
            return;
          }

          if (
            !shouldReconnectForTrackDiscoveryTimeout(
              WHEP_TRACK_DISCOVERY_GRACE_MS,
            )
          ) {
            return;
          }

          this.clearPlaybackMonitor();
          this.updateRecoveringPlaybackState("disconnected");
          this.disposeSession();
          this.queueReconnect({ immediate: true });
        }, WHEP_TRACK_DISCOVERY_GRACE_MS);
      }
    };

    const initializeRequiredReceivers = (
      receiverStats: WHEPInboundReceiverStat[],
    ) => {
      if (
        this.playbackMonitor !== playbackMonitor ||
        !this.isActiveSession(attemptId, session)
      ) {
        return;
      }

      playbackMonitor.requiredReceiverIds = receiverStats.map(
        (stat) => stat.id,
      );
      playbackMonitor.lastBytesReceivedByReceiver.clear();
      playbackMonitor.receiverStalledForMs.clear();
      for (const receiverStat of receiverStats) {
        playbackMonitor.lastBytesReceivedByReceiver.set(
          receiverStat.id,
          receiverStat.bytesReceived,
        );
        playbackMonitor.receiverStalledForMs.set(receiverStat.id, 0);
      }
      clearDiscoveryTimeout();
    };

    const tick = () => {
      if (
        this.playbackMonitor !== playbackMonitor ||
        !this.isActiveSession(attemptId, session) ||
        document.visibilityState !== "visible" ||
        pollInFlight
      ) {
        return;
      }

      pollInFlight = true;
      void session
        .getInboundReceiverStats()
        .then((receiverStats) => {
          if (
            this.playbackMonitor !== playbackMonitor ||
            !this.isActiveSession(attemptId, session)
          ) {
            return;
          }

          if (playbackMonitor.requiredReceiverIds === null) {
            if (receiverStats.length < playbackMonitor.expectedTrackCount) {
              return;
            }

            initializeRequiredReceivers(receiverStats);
            return;
          }

          const receiverStatsById = new Map(
            receiverStats.map((receiverStat) => [
              receiverStat.id,
              receiverStat,
            ]),
          );

          for (const receiverId of playbackMonitor.requiredReceiverIds) {
            const receiverStat = receiverStatsById.get(receiverId);
            const previousBytesReceived =
              playbackMonitor.lastBytesReceivedByReceiver.get(receiverId) ?? 0;
            const nextStalledForMs =
              receiverStat === undefined ||
              receiverStat.bytesReceived <= previousBytesReceived
                ? (playbackMonitor.receiverStalledForMs.get(receiverId) ?? 0) +
                  1_000
                : 0;

            if (receiverStat !== undefined) {
              playbackMonitor.lastBytesReceivedByReceiver.set(
                receiverId,
                receiverStat.bytesReceived,
              );
            }
            playbackMonitor.receiverStalledForMs.set(
              receiverId,
              nextStalledForMs,
            );

            if (!shouldReconnectForPlaybackStall(nextStalledForMs)) {
              continue;
            }

            this.clearPlaybackMonitor();
            this.updateRecoveringPlaybackState("disconnected");
            this.disposeSession();
            this.queueReconnect({ immediate: true });
            return;
          }
        })
        .finally(() => {
          pollInFlight = false;
        });
    };

    const handleVisibilityChange = () => {
      syncMonitor();
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    playbackMonitor.cleanup = () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };

    this.playbackMonitor = playbackMonitor;
    playbackMonitor.sync = syncMonitor;
    syncMonitor();
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
            this.handleConnected(resourceUserId, session);
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
        this.handleConnected(resourceUserId, session);
      }
    } finally {
      if (mode === "initial" && this.loadingAttemptId === attemptId) {
        this.loadingAttemptId = null;
        this.updateSnapshot({ isLoading: false });
      }
    }
  }
}
