import {
  deleteWhepSession,
  patchWhepAnswer,
  postWhepOffer,
  WHEPSessionError,
} from "./signaling";
import { fetchTurnIceServers } from "./turn-credentials";

export type WHEPConnectionStatus =
  "disconnected" | "connecting" | "connected" | "failed";

export type WHEPSessionSnapshot = {
  connectionState: RTCPeerConnectionState;
  expectedRemoteTrackCount: number;
  hasStream: boolean;
  iceConnectionState: RTCIceConnectionState;
  liveTrackCount: number;
  mutedTrackCount: number;
  remoteTrackCount: number;
  signalingState: RTCSignalingState;
  status: WHEPConnectionStatus;
};

export type WHEPInboundReceiverStat = {
  bytesReceived: number;
  id: string;
  kind: "audio" | "video";
};

type WHEPSessionCallbacks = {
  onStatusChange?: (status: WHEPConnectionStatus) => void;
  onStreamChange?: (hasStream: boolean) => void;
};

type WHEPSessionHandlers = Required<WHEPSessionCallbacks>;

type WHEPSessionRuntimeState =
  | { hasStream: false; status: "disconnected" }
  | { hasStream: false; status: "connecting" }
  | { hasStream: boolean; status: "connected" }
  | { hasStream: false; status: "failed" };

type WHEPSessionLifecycle =
  | { kind: "active" }
  | { kind: "releasingLocalResources" }
  | { cleanupPromise: Promise<void>; kind: "closingServerSession" }
  | { kind: "disposed" };

/** セッションが使うのは再生ソースの差し替えと再生開始だけで、HTMLVideoElement の他の機能は不要。 */
type WHEPVideoElement = Pick<HTMLVideoElement, "srcObject" | "play">;

type WHEPSessionOptions = {
  callbacks?: WHEPSessionCallbacks;
  resourceUserId: string;
  videoElement: WHEPVideoElement;
};

function createRuntimeState(
  status: WHEPConnectionStatus,
  previousState?: WHEPSessionRuntimeState,
): WHEPSessionRuntimeState {
  switch (status) {
    case "disconnected":
      return { hasStream: false, status };
    case "connecting":
      return { hasStream: false, status };
    case "connected":
      return {
        hasStream:
          previousState?.status === "connected"
            ? previousState.hasStream
            : false,
        status,
      };
    case "failed":
      return { hasStream: false, status };
  }
}

function readInboundReceiverBytes(report: unknown): number | null {
  if (typeof report !== "object" || report === null) {
    return null;
  }

  const type: unknown = Reflect.get(report, "type");
  const bytesReceived: unknown = Reflect.get(report, "bytesReceived");
  if (type !== "inbound-rtp" || typeof bytesReceived !== "number") {
    return null;
  }

  return bytesReceived;
}

function isIceGatheringFinished(pc: RTCPeerConnection): boolean {
  if (pc.iceGatheringState === "complete") {
    return true;
  }

  return pc.signalingState === "closed" || pc.connectionState === "closed";
}

/** @throws {WHEPSessionError} 収集の完了前に `signal` が中断された場合。 */
async function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw new WHEPSessionError("WHEP connection was aborted", {
      kind: "aborted",
      responseText: undefined,
      stage: "local",
    });
  }

  if (isIceGatheringFinished(pc)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const onStateChange = () => {
      if (isIceGatheringFinished(pc)) {
        cleanup();
        resolve();
      }
    };
    const cleanup = () => {
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      pc.removeEventListener("connectionstatechange", onStateChange);
      pc.removeEventListener("signalingstatechange", onStateChange);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(
        new WHEPSessionError("WHEP connection was aborted", {
          kind: "aborted",
          responseText: undefined,
          stage: "local",
        }),
      );
    };

    pc.addEventListener("icegatheringstatechange", onStateChange);
    pc.addEventListener("connectionstatechange", onStateChange);
    pc.addEventListener("signalingstatechange", onStateChange);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class WHEPSession {
  private readonly abortController = new AbortController();
  private readonly callbacks: WHEPSessionHandlers;
  private readonly eventListenerCleanups: Array<() => void> = [];
  private readonly pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
  private readonly remoteStream = new MediaStream();
  private readonly remoteTrackCleanups = new Map<
    MediaStreamTrack,
    () => void
  >();
  private readonly resourceUserId: string;
  private readonly videoElement: WHEPVideoElement;
  private expectedRemoteTrackCount = 0;
  private lifecycle: WHEPSessionLifecycle = { kind: "active" };
  private maxRemoteTrackCount = 0;
  private runtimeState: WHEPSessionRuntimeState =
    createRuntimeState("disconnected");
  /** POST /play 成功後に Worker が返した WHEP セッション URL。 */
  private serverSessionUrl: URL | null = null;

  /** @throws {Error} `resourceUserId` が空白だけの場合。 */
  constructor({
    callbacks = {},
    resourceUserId,
    videoElement,
  }: WHEPSessionOptions) {
    const trimmedResourceUserId = resourceUserId.trim();
    if (trimmedResourceUserId.length === 0) {
      throw new Error("Resource user id is required");
    }

    this.callbacks = {
      onStatusChange: callbacks.onStatusChange ?? (() => undefined),
      onStreamChange: callbacks.onStreamChange ?? (() => undefined),
    };
    this.resourceUserId = trimmedResourceUserId;
    this.videoElement = videoElement;
    this.videoElement.srcObject = this.remoteStream;

    this.attachConnectionListeners();
    this.attachTrackListener();
    this.attachMediaStreamListeners();
    this.pc.addTransceiver("video", { direction: "recvonly" });
    this.pc.addTransceiver("audio", { direction: "recvonly" });
  }

  private isActive(): boolean {
    return this.lifecycle.kind === "active";
  }

  private setStatus(nextStatus: WHEPConnectionStatus): void {
    const previousState = this.runtimeState;
    const nextState = createRuntimeState(nextStatus, previousState);
    this.runtimeState = nextState;
    if (previousState.status !== nextState.status) {
      this.callbacks.onStatusChange(nextStatus);
    }
    if (previousState.hasStream !== nextState.hasStream) {
      this.callbacks.onStreamChange(nextState.hasStream);
    }
  }

  private setStreamState(hasStream: boolean): void {
    const previousState = this.runtimeState;
    if (
      previousState.status !== "connected" ||
      previousState.hasStream === hasStream
    ) {
      return;
    }

    this.runtimeState = { hasStream, status: "connected" };
    this.callbacks.onStreamChange(hasStream);
  }

  getSnapshot(): WHEPSessionSnapshot {
    const remoteTracks = this.remoteStream.getTracks();
    const liveTrackCount = remoteTracks.filter((track) => {
      return track.readyState === "live";
    }).length;
    const mutedTrackCount = remoteTracks.filter((track) => {
      return track.muted;
    }).length;

    return {
      connectionState: this.pc.connectionState,
      expectedRemoteTrackCount: Math.max(
        this.expectedRemoteTrackCount,
        this.maxRemoteTrackCount,
        remoteTracks.length,
      ),
      hasStream: this.runtimeState.hasStream,
      iceConnectionState: this.pc.iceConnectionState,
      liveTrackCount,
      mutedTrackCount,
      remoteTrackCount: remoteTracks.length,
      signalingState: this.pc.signalingState,
      status: this.runtimeState.status,
    };
  }

  async getInboundReceiverStats(): Promise<WHEPInboundReceiverStat[]> {
    const statsByReceiver = await Promise.all(
      this.pc.getReceivers().map(async (receiver) => {
        const track = receiver.track;
        if (track.kind !== "audio" && track.kind !== "video") {
          return null;
        }

        const receiverStats = await receiver.getStats();
        let bytesReceived: number | undefined;
        receiverStats.forEach((report) => {
          if (bytesReceived !== undefined) {
            return;
          }

          const nextBytesReceived = readInboundReceiverBytes(report);
          if (nextBytesReceived !== null) {
            bytesReceived = nextBytesReceived;
          }
        });

        if (bytesReceived === undefined) {
          return null;
        }

        const transceiver = this.pc
          .getTransceivers()
          .find((candidate) => candidate.receiver === receiver);
        const id =
          (typeof transceiver?.mid === "string" && transceiver.mid.length > 0
            ? transceiver.mid
            : track.id) || null;
        if (!id) {
          return null;
        }

        return {
          bytesReceived,
          id,
          kind: track.kind,
        } satisfies WHEPInboundReceiverStat;
      }),
    );

    return statsByReceiver.filter((stat) => stat !== null);
  }

  private deriveIceConnectionStatus(
    state: RTCIceConnectionState,
  ): WHEPConnectionStatus {
    switch (state) {
      case "new":
      case "checking":
        return "connecting";
      case "disconnected":
        return "disconnected";
      case "connected":
      case "completed":
        return "connected";
      case "failed":
        return "failed";
      case "closed":
        return "disconnected";
    }
  }

  private deriveConnectionStatus(): WHEPConnectionStatus {
    const iceStatus = this.deriveIceConnectionStatus(
      this.pc.iceConnectionState,
    );

    if (this.pc.signalingState === "closed") {
      return "disconnected";
    }

    if (iceStatus === "failed" || iceStatus === "disconnected") {
      return iceStatus;
    }

    switch (this.pc.connectionState) {
      case "new":
      case "connecting":
      case "disconnected":
        return "connecting";
      case "connected":
        if (iceStatus === "connecting") {
          return "connecting";
        }

        return "connected";
      case "failed":
        return "failed";
      case "closed":
        return "disconnected";
    }
  }

  private refreshConnectionStatus(): void {
    if (!this.isActive()) {
      return;
    }

    const nextStatus = this.deriveConnectionStatus();
    this.setStatus(nextStatus);
    this.refreshStreamState();
  }

  private refreshStreamState(): void {
    if (!this.isActive()) {
      return;
    }

    const remoteTracks = this.remoteStream.getTracks();
    this.maxRemoteTrackCount = Math.max(
      this.maxRemoteTrackCount,
      remoteTracks.length,
    );

    const hasLiveUnmutedTrack = remoteTracks.some((track) => {
      return track.readyState === "live" && !track.muted;
    });

    this.setStreamState(hasLiveUnmutedTrack);
  }

  private addPeerConnectionListener<K extends keyof RTCPeerConnectionEventMap>(
    type: K,
    listener: (event: RTCPeerConnectionEventMap[K]) => void,
  ): void {
    this.pc.addEventListener(type, listener);
    this.eventListenerCleanups.push(() => {
      this.pc.removeEventListener(type, listener);
    });
  }

  private addMediaStreamListener<K extends keyof MediaStreamEventMap>(
    type: K,
    listener: (event: MediaStreamEventMap[K]) => void,
  ): void {
    this.remoteStream.addEventListener(type, listener);
    this.eventListenerCleanups.push(() => {
      this.remoteStream.removeEventListener(type, listener);
    });
  }

  private addMediaStreamTrackListener<K extends keyof MediaStreamTrackEventMap>(
    track: MediaStreamTrack,
    type: K,
    listener: (event: MediaStreamTrackEventMap[K]) => void,
  ): () => void {
    track.addEventListener(type, listener);
    return () => {
      track.removeEventListener(type, listener);
    };
  }

  private cleanupEventListeners(): void {
    const cleanups = [...this.eventListenerCleanups];
    this.eventListenerCleanups.length = 0;

    for (const cleanup of cleanups) {
      cleanup();
    }

    this.remoteTrackCleanups.clear();
  }

  private attachConnectionListeners(): void {
    const refreshStatus = () => {
      this.refreshConnectionStatus();
    };

    this.addPeerConnectionListener("connectionstatechange", refreshStatus);
    this.addPeerConnectionListener("iceconnectionstatechange", refreshStatus);
    this.addPeerConnectionListener("icegatheringstatechange", refreshStatus);
    this.addPeerConnectionListener("signalingstatechange", refreshStatus);
    this.addPeerConnectionListener("icecandidate", refreshStatus);
    this.addPeerConnectionListener("negotiationneeded", refreshStatus);
    this.addPeerConnectionListener("icecandidateerror", (event) => {
      if (!this.isActive()) {
        return;
      }

      console.warn("ICE candidate error:", {
        errorCode: event.errorCode,
        errorText: event.errorText,
        url: event.url,
      });
      refreshStatus();
    });
  }

  private attachTrackListener(): void {
    this.addPeerConnectionListener("track", (event) => {
      if (!this.isActive()) {
        return;
      }

      this.remoteStream.addTrack(event.track);
      this.attachRemoteTrackListeners(event.track);
      // MediaStream.addTrack() は "addtrack" イベントを発火しないため、ここで直接更新する。
      this.refreshStreamState();
      void this.videoElement.play().catch((error: Error) => {
        console.warn("Autoplay failed:", error);
      });
    });
  }

  private attachMediaStreamListeners(): void {
    this.addMediaStreamListener("addtrack", (event) => {
      if (!this.isActive()) {
        return;
      }

      this.attachRemoteTrackListeners(event.track);
      this.refreshStreamState();
    });

    this.addMediaStreamListener("removetrack", (event) => {
      if (!this.isActive()) {
        return;
      }

      this.cleanupRemoteTrack(event.track);
      this.refreshStreamState();
    });
  }

  private attachRemoteTrackListeners(track: MediaStreamTrack): void {
    if (this.remoteTrackCleanups.has(track)) {
      return;
    }

    const cleanups = [
      this.addMediaStreamTrackListener(track, "mute", () => {
        this.refreshStreamState();
      }),
      this.addMediaStreamTrackListener(track, "unmute", () => {
        this.refreshStreamState();
      }),
      this.addMediaStreamTrackListener(track, "ended", () => {
        this.refreshStreamState();
        this.cleanupRemoteTrack(track);
      }),
    ];

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) {
        return;
      }

      cleaned = true;
      for (const cleanupTrackListener of cleanups) {
        cleanupTrackListener();
      }
      this.remoteTrackCleanups.delete(track);
    };

    this.remoteTrackCleanups.set(track, cleanup);
    this.eventListenerCleanups.push(cleanup);
  }

  private cleanupRemoteTrack(track: MediaStreamTrack): void {
    const cleanup = this.remoteTrackCleanups.get(track) ?? (() => undefined);
    cleanup();
  }

  private releaseLocalResources(): void {
    this.cleanupEventListeners();
    this.pc.close();

    this.remoteStream.getTracks().forEach((track) => {
      track.stop();
    });

    this.videoElement.srcObject = null;
    this.setStreamState(false);
    this.setStatus("disconnected");
  }

  private async deleteServerSession(): Promise<void> {
    if (this.serverSessionUrl !== null) {
      await deleteWhepSession(this.serverSessionUrl);
    }
  }

  /**
   * このセッションの再生ネゴシエーションを行う。
   *
   * 処理中に `attemptSignal` が中断されるかセッションが破棄された場合は静かに
   * 解決する。それ以外の失敗では、エラーを再スローする前にセッション自身を破棄して
   * `failed` を報告する。
   *
   * @throws {WHEPSessionError} WHEP リソースがセッションを拒否したか予期しない応答を
   * 返した場合。配信終了か配信者の再接続待ちかは `kind` で判別できる。
   * @throws {Error} ローカル SDP ネゴシエーションまたはリクエストが失敗した場合。
   */
  async start(attemptSignal: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([
      attemptSignal,
      this.abortController.signal,
    ]);
    if (!this.isActive() || signal.aborted) {
      return;
    }

    this.setStatus("connecting");

    const runStart = async (): Promise<void> => {
      const turnIceServers = await fetchTurnIceServers(signal);
      if (turnIceServers !== null) {
        this.pc.setConfiguration({
          ...this.pc.getConfiguration(),
          iceServers: turnIceServers,
        });
      }

      const localOffer = await this.pc.createOffer();
      await this.pc.setLocalDescription(localOffer);
      // Worker 経路はトリクル ICE を扱わないため、ICE 収集を終えた完全なオファーを送る
      // （docs/architecture.md「WHEPクライアントの設計判断」）。
      await waitForIceGatheringComplete(this.pc, signal);

      const localOfferSdp = this.pc.localDescription?.sdp;
      if (!localOfferSdp) {
        throw new Error("Failed to create local SDP offer");
      }

      // 破棄時はこの POST を中断する。作成済みの SFU 再生セッションには DELETE を送らないが、
      // 誰も接続しないまま SFU が片付ける。
      const sessionResponse = await postWhepOffer(
        this.resourceUserId,
        localOfferSdp,
        signal,
      );
      this.expectedRemoteTrackCount =
        sessionResponse.expectedRemoteTrackCount ?? 0;
      this.serverSessionUrl = sessionResponse.sessionUrl;

      if (!this.isActive()) {
        return;
      }

      switch (sessionResponse.kind) {
        case "counterOffer": {
          await this.pc.setLocalDescription({ type: "rollback" });
          await this.pc.setRemoteDescription(
            new RTCSessionDescription({
              type: "offer",
              sdp: sessionResponse.sdp,
            }),
          );

          const localAnswer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(localAnswer);
          // この PATCH は 406 カウンターオファーへのアンサーであり、トリクル ICE ではないため
          // 完全なアンサーを送る。
          await waitForIceGatheringComplete(this.pc, signal);

          const localAnswerSdp = this.pc.localDescription.sdp;
          if (!localAnswerSdp) {
            throw new Error("Failed to create local SDP answer");
          }

          await patchWhepAnswer(
            sessionResponse.sessionUrl,
            localAnswerSdp,
            signal,
          );
          break;
        }
        case "accepted":
          await this.pc.setRemoteDescription(
            new RTCSessionDescription({
              type: "answer",
              sdp: sessionResponse.sdp,
            }),
          );
          break;
      }
    };

    await runStart().catch(async (error: unknown) => {
      if (signal.aborted || !this.isActive()) {
        return;
      }

      await this.dispose({ notifyServer: true });
      this.setStatus("failed");
      throw error;
    });
  }

  async dispose(options?: { notifyServer?: boolean }): Promise<void> {
    const notifyServer = options?.notifyServer ?? true;

    if (this.lifecycle.kind === "closingServerSession") {
      await this.lifecycle.cleanupPromise;
      return;
    }
    if (
      this.lifecycle.kind === "disposed" ||
      this.lifecycle.kind === "releasingLocalResources"
    ) {
      return;
    }

    this.lifecycle = { kind: "releasingLocalResources" };
    this.abortController.abort();
    this.releaseLocalResources();

    const cleanupPromise = notifyServer
      ? this.deleteServerSession()
      : Promise.resolve();
    this.lifecycle = { cleanupPromise, kind: "closingServerSession" };

    try {
      await cleanupPromise;
    } finally {
      this.lifecycle = { kind: "disposed" };
    }
  }
}
