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
  shouldRecoverEstablishedSession,
} from "./whep-reconnect";
import {
  createDefaultPlaybackState,
  createPlaybackState,
  type WHEPPlaybackState,
} from "./whep-playback";

type AttemptMode = WHEPReconnectAttemptMode;
type AttemptId = symbol;

type PendingAttempt = {
  abortController: AbortController;
  attemptId: AttemptId;
  mode: AttemptMode;
  resourceUserId: string;
};

type PlaybackMonitorState = {
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
  if (phase === "ended") {
    return {
      connectionStatus: "disconnected",
      hasStream: false,
      phase,
      resourceUserId,
      retryCount: 0,
    };
  }

  return {
    connectionStatus: "failed",
    hasStream: false,
    phase,
    resourceUserId,
    retryCount: 0,
  };
}

export class WHEPPlaybackController {
  private attemptAbortController: AbortController | null = null;
  private attemptId: AttemptId = Symbol("WHEP playback attempt");
  private disposed = false;
  private loadingAttemptId: AttemptId | null = null;
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
  private videoElement: HTMLVideoElement | null = null;

  attachVideoElement(videoElement: HTMLVideoElement | null): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }

    this.videoElement = videoElement;

    if (!videoElement || this.pendingAttempt === null) {
      return Promise.resolve();
    }

    const pendingAttempt = this.pendingAttempt;
    this.pendingAttempt = null;
    return this.startAttempt(pendingAttempt);
  }

  load(resourceUserId: string): Promise<void> {
    const trimmedResourceUserId = resourceUserId.trim();
    if (trimmedResourceUserId.length === 0 || this.disposed) {
      return Promise.resolve();
    }

    this.resetRuntime();

    const attempt = this.createAttempt("initial", trimmedResourceUserId);
    this.loadingAttemptId = attempt.attemptId;
    this.updateSnapshot({
      isLoading: true,
      playbackState: createPlaybackState(
        trimmedResourceUserId,
        "connecting",
        "connecting",
        0,
      ),
    });

    return this.startAttempt(attempt);
  }

  disconnect(): void {
    this.resetRuntime();
    this.replaceSnapshot(createDefaultSnapshot());
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.snapshotSubscriber = null;
    this.resetRuntime();
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

  private bumpAttemptId(): AttemptId {
    this.attemptId = Symbol("WHEP playback attempt");
    return this.attemptId;
  }

  private createAttempt(
    mode: AttemptMode,
    resourceUserId: string,
  ): PendingAttempt {
    this.pendingAttempt = null;
    this.disposeSession();

    const abortController = new AbortController();
    this.attemptAbortController = abortController;
    return {
      abortController,
      attemptId: this.bumpAttemptId(),
      mode,
      resourceUserId,
    };
  }

  private isActiveSession(attemptId: AttemptId, session: WHEPSession): boolean {
    return this.attemptId === attemptId && this.session === session;
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
    this.attemptAbortController?.abort();
    this.attemptAbortController = null;

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

  private resetRuntime(): void {
    this.bumpAttemptId();
    this.pendingAttempt = null;
    this.loadingAttemptId = null;
    this.clearPlaybackMonitor();
    this.clearRecoveryTimer();
    this.clearReconnectState();
    this.disposeSession();

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
    this.resetRuntime();
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
      this.queueReconnect(resourceUserId);
      return;
    }

    if (resolveReconnectDisposition(error) === "error") {
      this.finalizePlayback("error", resourceUserId, error);
      return;
    }

    // resource_not_found was handled above; remaining dispositions retry.
    this.queueReconnect(resourceUserId);
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
    resourceUserId: string,
    connectionStatus: "disconnected" | "failed",
  ): void {
    this.updatePlaybackState({
      connectionStatus,
      hasStream: false,
      phase: "reconnecting",
      resourceUserId,
      retryCount: this.retryCount,
    });
  }

  private queueReconnect(
    resourceUserId: string,
    options?: { immediate?: boolean },
  ): void {
    this.clearPlaybackMonitor();
    this.clearRecoveryTimer();

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

    const delayMs = options?.immediate
      ? 0
      : getReconnectDelayMs(this.retryCount, this.reconnectDeadlineAt - now);
    this.reconnectTimerId = window.setTimeout(() => {
      this.reconnectTimerId = null;

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
      void this.startAttempt(this.createAttempt("retry", resourceUserId));
    }, delayMs);
  }

  private startRecoveryTimer(
    session: WHEPSession,
    resourceUserId: string,
  ): void {
    const sessionSnapshot = session.getSnapshot();
    if (!shouldRecoverEstablishedSession(sessionSnapshot)) {
      this.clearRecoveryTimer();
      return;
    }
    if (this.recoveryTimerId !== null || this.reconnectTimerId !== null) {
      return;
    }

    this.clearPlaybackMonitor();
    this.updateRecoveringPlaybackState(resourceUserId, sessionSnapshot.status);
    this.recoveryTimerId = window.setTimeout(() => {
      this.recoveryTimerId = null;

      this.disposeSession();
      this.queueReconnect(resourceUserId, { immediate: true });
    }, WHEP_SESSION_RECOVERY_GRACE_MS);
  }

  private startPlaybackMonitor(
    attemptId: AttemptId,
    session: WHEPSession,
    resourceUserId: string,
  ): void {
    this.clearPlaybackMonitor();

    const playbackMonitor: PlaybackMonitorState = {
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

    // This is the primary end-of-stream detection path. When an ingest ends,
    // the SFU session/track metadata can still look valid long enough for the
    // viewer to keep the PeerConnection open, but RTP bytes stop advancing.
    // Watch per-receiver bytesReceived and reconnect this stream when expected
    // media stops flowing.
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
      if (playbackMonitor.intervalId !== null) {
        return;
      }

      playbackMonitor.intervalId = window.setInterval(tick, 1_000);
    };

    const syncMonitor = () => {
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
        // Receiver stats can lag behind SDP/track events. Until every expected
        // inbound RTP receiver appears, bytesReceived monitoring cannot prove
        // playback health. If the receivers never appear, the negotiated session
        // is incomplete and must be replaced.
        playbackMonitor.discoveryTimeoutId = window.setTimeout(() => {
          playbackMonitor.discoveryTimeoutId = null;

          if (
            this.playbackMonitor !== playbackMonitor ||
            !this.isActiveSession(attemptId, session) ||
            playbackMonitor.requiredReceiverIds !== null
          ) {
            return;
          }

          this.clearPlaybackMonitor();
          this.updateRecoveringPlaybackState(resourceUserId, "disconnected");
          this.disposeSession();
          this.queueReconnect(resourceUserId, { immediate: true });
        }, WHEP_TRACK_DISCOVERY_GRACE_MS);
      }
    };

    const initializeRequiredReceivers = (
      receiverStats: WHEPInboundReceiverStat[],
    ) => {
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
            this.updateRecoveringPlaybackState(resourceUserId, "disconnected");
            this.disposeSession();
            this.queueReconnect(resourceUserId, { immediate: true });
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
    abortController,
    attemptId,
    mode,
    resourceUserId,
  }: PendingAttempt): Promise<void> {
    if (this.videoElement === null) {
      this.pendingAttempt = {
        abortController,
        attemptId,
        mode,
        resourceUserId,
      };
      return;
    }

    const phase = mode === "retry" ? "reconnecting" : "connecting";
    let sessionWasConnected = false;

    this.pendingAttempt = null;
    this.clearPlaybackMonitor();
    this.clearRecoveryTimer();
    this.clearReconnectTimer();

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

          this.startRecoveryTimer(session, resourceUserId);
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
      const startResult = await session.start(abortController.signal);
      abortController.signal.throwIfAborted();

      if (startResult.isErr()) {
        this.session = null;
        this.handleAttemptFailure(startResult.error, mode, resourceUserId);
        return;
      }

      if (session.getSnapshot().status === "connected") {
        sessionWasConnected = true;
        this.handleConnected(resourceUserId, session);
      }
    } catch (error: unknown) {
      if (!(error instanceof Error && error.name === "AbortError")) {
        throw error;
      }
    } finally {
      if (this.attemptAbortController === abortController) {
        this.attemptAbortController = null;
      }
      if (mode === "initial" && this.loadingAttemptId === attemptId) {
        this.loadingAttemptId = null;
        this.updateSnapshot({ isLoading: false });
      }
    }
  }
}
