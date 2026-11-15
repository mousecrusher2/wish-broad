import {
  WHEPSession,
  WHEPSessionError,
  type WHEPInboundReceiverStat,
} from "./session";
import {
  type WHEPReconnectAttemptMode,
  WHEP_RECONNECT_DELAY_MS,
  WHEP_RECONNECT_WINDOW_MS,
  WHEP_SESSION_RECOVERY_GRACE_MS,
  WHEP_TRACK_DISCOVERY_GRACE_MS,
  resolveReconnectDisposition,
  shouldReconnectForPlaybackStall,
  shouldRecoverEstablishedSession,
} from "./reconnect-policy";
import {
  createDefaultPlaybackState,
  createPlaybackState,
  type WHEPPlaybackState,
} from "./playback-state";

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

function isUnavailableError(error: Error): boolean {
  return error instanceof WHEPSessionError && error.isUnavailable();
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
    };
  }

  return {
    connectionStatus: "failed",
    hasStream: false,
    phase,
    resourceUserId,
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
  private reconnectTimerId: number | null = null;
  private recoveryTimerId: number | null = null;
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
    // Worker が 404 を返すのは配信が終了した場合のみであり、配信者の再接続待ちの間は
    // 409 を返す。そのため 404 に対してはリトライしない。
    if (isNotFoundError(error)) {
      this.finalizePlayback("ended", resourceUserId);
      return;
    }

    // すでに配信者の再接続待ちとなっている配信を初回読み込みした場合でも、
    // 配信者の再接続を待機する。
    if (isUnavailableError(error)) {
      this.queueReconnect(resourceUserId);
      return;
    }

    if (mode === "initial" || resolveReconnectDisposition(error) === "error") {
      this.finalizePlayback("error", resourceUserId, error);
      return;
    }

    this.queueReconnect(resourceUserId);
  }

  private failUnconnectedAttempt(
    mode: AttemptMode,
    resourceUserId: string,
  ): void {
    // ICE リスタートを行わない限り、ICE "failed" は終端状態となる。一度も接続できていない
    // セッションにはリカバリータイマーも再生モニターも動いていないため、UI が停止したままに
    // ならないよう他の失敗試行と同様にセッションを置き換える。
    this.disposeSession();
    this.handleAttemptFailure(
      new Error("WHEP ICE connection failed before playback connected"),
      mode,
      resourceUserId,
    );
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
    });
  }

  private queueReconnect(
    resourceUserId: string,
    options?: { immediate?: boolean },
  ): void {
    this.clearPlaybackMonitor();
    this.clearRecoveryTimer();

    const now = Date.now();
    this.reconnectDeadlineAt ??= now + WHEP_RECONNECT_WINDOW_MS;

    if (now >= this.reconnectDeadlineAt) {
      this.finalizePlayback(
        "error",
        resourceUserId,
        new Error("WHEP reconnect window expired"),
      );
      return;
    }

    this.updatePlaybackState({
      connectionStatus: "connecting",
      hasStream: false,
      phase: "reconnecting",
      resourceUserId,
    });

    // 上記の期限チェックにより、残り時間は常に正の値になる。
    const delayMs = options?.immediate
      ? 0
      : Math.min(WHEP_RECONNECT_DELAY_MS, this.reconnectDeadlineAt - now);
    this.reconnectTimerId = window.setTimeout(() => {
      this.reconnectTimerId = null;

      const reconnectDeadlineAt = this.reconnectDeadlineAt;
      if (reconnectDeadlineAt === null || Date.now() >= reconnectDeadlineAt) {
        this.finalizePlayback(
          "error",
          resourceUserId,
          new Error("WHEP reconnect window expired"),
        );
        return;
      }
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

    // レシーバーごとの bytesReceived の監視は、配信終了を検知する主要な経路である
    // （docs/architecture.md「フロントエンドのリカバリー」）。
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
        // レシーバーの統計情報は SDP や track イベントより遅れて現れることがあり、すべて揃うまで
        // bytesReceived では再生の健全性を判断できない。揃わないまま期限が来たら作り直す。
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
        .catch((error: Error) => {
          // ポーリング途中で dispose() が PeerConnection を閉じた直後、ブラウザによっては
          // getStats() が reject される場合がある。停止検知ではこのティックを単にスキップする。
          console.warn("Failed to read WHEP receiver stats:", error);
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
    // start() の実行中に報告された失敗は start() 自身のエラー結果に属する。
    // ここではシグナリング成功後の ICE 失敗のみを扱う。
    let signalingCompleted = false;

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
            if (status === "failed" && signalingCompleted) {
              this.failUnconnectedAttempt(mode, resourceUserId);
              return;
            }

            this.updatePlaybackState(
              createPlaybackState(resourceUserId, phase, status),
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
      createPlaybackState(resourceUserId, phase, "connecting"),
    );

    try {
      const startFailure = await session.start(abortController.signal).then(
        () => null,
        (error: unknown) =>
          error instanceof Error ? error : new Error(String(error)),
      );
      abortController.signal.throwIfAborted();
      if (startFailure) {
        this.session = null;
        this.handleAttemptFailure(startFailure, mode, resourceUserId);
        return;
      }

      signalingCompleted = true;
      const { status } = session.getSnapshot();
      if (status === "connected") {
        sessionWasConnected = true;
        this.handleConnected(resourceUserId, session);
      } else if (
        status === "failed" &&
        this.isActiveSession(attemptId, session)
      ) {
        this.failUnconnectedAttempt(mode, resourceUserId);
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
