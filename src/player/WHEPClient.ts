export type WHEPConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed";

type WHEPClientCallbacks = {
  onStatusChange?: (status: WHEPConnectionStatus) => void;
  onStreamChange?: (hasStream: boolean) => void;
};

function assertUnreachableState(state: never): never {
  void state;
  throw new Error("Unexpected connection state");
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function createAbortError(): Error {
  return new Error("WHEP connection was aborted");
}

function isIceGatheringFinished(pc: RTCPeerConnection): boolean {
  if (pc.iceGatheringState === "complete") {
    return true;
  }

  return pc.signalingState === "closed" || pc.connectionState === "closed";
}

async function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw createAbortError();
  }

  if (isIceGatheringFinished(pc)) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      pc.removeEventListener("icegatheringstatechange", onStateChange);
      pc.removeEventListener("connectionstatechange", onStateChange);
      pc.removeEventListener("signalingstatechange", onStateChange);
      signal.removeEventListener("abort", onAbort);
    };

    const onGatheringStateChange = () => {
      if (isIceGatheringFinished(pc)) {
        cleanup();
        resolve();
      }
    };

    const onStateChange = onGatheringStateChange;
    const onAbort = () => {
      cleanup();
      reject(createAbortError());
    };

    pc.addEventListener("icegatheringstatechange", onStateChange);
    pc.addEventListener("connectionstatechange", onStateChange);
    pc.addEventListener("signalingstatechange", onStateChange);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class WHEPClient {
  private pc: RTCPeerConnection | null = null;
  private remoteStream: MediaStream | null = null;
  private status: WHEPConnectionStatus = "disconnected";
  private hasStream = false;
  private connectAbortController: AbortController | null = null;
  private sessionLocation: string | null = null;
  private eventListenerCleanups: Array<() => void> = [];
  private remoteTrackCleanups = new Map<MediaStreamTrack, () => void>();

  constructor(
    private readonly videoElement: HTMLVideoElement,
    private readonly callbacks: WHEPClientCallbacks = {},
  ) {}

  private setStatus(nextStatus: WHEPConnectionStatus): void {
    if (this.status === nextStatus) {
      return;
    }

    this.status = nextStatus;
    this.callbacks.onStatusChange?.(nextStatus);
  }

  private setStreamState(hasStream: boolean): void {
    if (this.hasStream === hasStream) {
      return;
    }

    this.hasStream = hasStream;
    this.callbacks.onStreamChange?.(hasStream);
  }

  private deriveIceConnectionStatus(
    state: RTCIceConnectionState,
  ): WHEPConnectionStatus | null {
    switch (state) {
      case "new":
        return null;
      case "checking":
      case "disconnected":
        return "connecting";
      case "connected":
      case "completed":
        return "connected";
      case "failed":
        return "failed";
      case "closed":
        return "disconnected";
      default:
        return assertUnreachableState(state);
    }
  }

  private deriveConnectionStatus(pc: RTCPeerConnection): WHEPConnectionStatus {
    const iceStatus = this.deriveIceConnectionStatus(pc.iceConnectionState);

    if (pc.signalingState === "closed" || iceStatus === "disconnected") {
      return "disconnected";
    }

    if (pc.connectionState === "failed" || iceStatus === "failed") {
      return "failed";
    }

    switch (pc.connectionState) {
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
      default:
        return assertUnreachableState(pc.connectionState);
    }
  }

  private refreshConnectionStatus(pc: RTCPeerConnection): void {
    if (this.pc !== pc) {
      return;
    }

    const nextStatus = this.deriveConnectionStatus(pc);
    this.setStatus(nextStatus);

    if (nextStatus === "failed" || nextStatus === "disconnected") {
      this.setStreamState(false);
      return;
    }

    this.refreshStreamState();
  }

  private refreshStreamState(): void {
    const remoteStream = this.remoteStream;
    if (!remoteStream) {
      this.setStreamState(false);
      return;
    }

    const hasLiveUnmutedTrack = remoteStream.getTracks().some((track) => {
      return track.readyState === "live" && !track.muted;
    });

    this.setStreamState(hasLiveUnmutedTrack);
  }

  private addPeerConnectionListener<K extends keyof RTCPeerConnectionEventMap>(
    pc: RTCPeerConnection,
    type: K,
    listener: (event: RTCPeerConnectionEventMap[K]) => void,
  ): void {
    pc.addEventListener(type, listener);
    this.eventListenerCleanups.push(() => {
      pc.removeEventListener(type, listener);
    });
  }

  private addMediaStreamListener<K extends keyof MediaStreamEventMap>(
    stream: MediaStream,
    type: K,
    listener: (event: MediaStreamEventMap[K]) => void,
  ): void {
    stream.addEventListener(type, listener);
    this.eventListenerCleanups.push(() => {
      stream.removeEventListener(type, listener);
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
    const cleanups = this.eventListenerCleanups;
    this.eventListenerCleanups = [];

    for (const cleanup of cleanups) {
      cleanup();
    }

    this.remoteTrackCleanups.clear();
  }

  private attachConnectionListeners(pc: RTCPeerConnection): void {
    const refreshStatus = () => {
      this.refreshConnectionStatus(pc);
    };

    this.addPeerConnectionListener(pc, "connectionstatechange", refreshStatus);
    this.addPeerConnectionListener(
      pc,
      "iceconnectionstatechange",
      refreshStatus,
    );
    this.addPeerConnectionListener(
      pc,
      "icegatheringstatechange",
      refreshStatus,
    );
    this.addPeerConnectionListener(pc, "signalingstatechange", refreshStatus);
    this.addPeerConnectionListener(pc, "icecandidate", refreshStatus);
    this.addPeerConnectionListener(pc, "negotiationneeded", refreshStatus);
    this.addPeerConnectionListener(pc, "icecandidateerror", (event) => {
      if (this.pc !== pc) {
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

  private attachTrackListener(pc: RTCPeerConnection): void {
    this.addPeerConnectionListener(pc, "track", (event) => {
      if (this.pc !== pc || !this.remoteStream) {
        return;
      }

      this.attachRemoteTrackListeners(event.track, this.remoteStream);
      this.remoteStream.addTrack(event.track);

      if (this.videoElement.srcObject !== this.remoteStream) {
        this.videoElement.srcObject = this.remoteStream;
      }

      this.refreshStreamState();
      void this.videoElement.play().catch((error) => {
        console.warn("Autoplay failed:", error);
      });
    });
  }

  private attachMediaStreamListeners(stream: MediaStream): void {
    this.addMediaStreamListener(stream, "addtrack", (event) => {
      if (this.remoteStream !== stream) {
        return;
      }

      this.attachRemoteTrackListeners(event.track, stream);
      this.refreshStreamState();
    });

    this.addMediaStreamListener(stream, "removetrack", (event) => {
      if (this.remoteStream !== stream) {
        return;
      }

      this.cleanupRemoteTrack(event.track);
      this.refreshStreamState();
    });
  }

  private attachRemoteTrackListeners(
    track: MediaStreamTrack,
    stream: MediaStream,
  ): void {
    if (this.remoteTrackCleanups.has(track)) {
      return;
    }

    const cleanups = [
      this.addMediaStreamTrackListener(track, "mute", () => {
        if (this.remoteStream === stream) {
          this.refreshStreamState();
        }
      }),
      this.addMediaStreamTrackListener(track, "unmute", () => {
        if (this.remoteStream === stream) {
          this.refreshStreamState();
        }
      }),
      this.addMediaStreamTrackListener(track, "ended", () => {
        if (this.remoteStream === stream) {
          this.refreshStreamState();
        }

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
    this.remoteTrackCleanups.get(track)?.();
  }

  async connect(resourceUserId: string): Promise<void> {
    const trimmedResourceUserId = resourceUserId.trim();
    if (trimmedResourceUserId.length === 0) {
      throw new Error("Resource user id is required");
    }

    await this.disconnect();

    const abortController = new AbortController();
    this.connectAbortController = abortController;
    this.setStatus("connecting");
    this.setStreamState(false);

    try {
      const resourceUrl = new URL(
        `/play/${encodeURIComponent(trimmedResourceUserId)}`,
        window.location.origin,
      );

      const pc = new RTCPeerConnection({
        bundlePolicy: "max-bundle",
      });
      this.pc = pc;
      this.remoteStream = new MediaStream();
      this.videoElement.srcObject = this.remoteStream;

      this.attachConnectionListeners(pc);
      this.attachTrackListener(pc);
      this.attachMediaStreamListeners(this.remoteStream);

      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });

      const localOffer = await pc.createOffer();
      await pc.setLocalDescription(localOffer);
      await waitForIceGatheringComplete(pc, abortController.signal);

      const localOfferSdp = pc.localDescription?.sdp;
      if (!localOfferSdp) {
        throw new Error("Failed to create local SDP offer");
      }

      const offerResponse = await fetch(resourceUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/sdp",
        },
        body: localOfferSdp,
        signal: abortController.signal,
      });
      if (!offerResponse.ok) {
        throw new Error(
          `Failed to create play session: ${String(offerResponse.status)}`,
        );
      }

      const sessionLocation = offerResponse.headers.get("location");
      if (!sessionLocation) {
        throw new Error("Missing session location header");
      }
      this.sessionLocation = sessionLocation;

      const remoteOfferSdp = await offerResponse.text();
      if (remoteOfferSdp.trim().length === 0) {
        throw new Error("Empty SDP response");
      }

      const sessionDescriptionTypeHeader = offerResponse.headers.get(
        "x-session-description-type",
      );
      const sessionDescriptionType =
        sessionDescriptionTypeHeader?.toLowerCase() === "offer"
          ? "offer"
          : "answer";

      if (sessionDescriptionType === "answer") {
        await pc.setRemoteDescription(
          new RTCSessionDescription({
            type: "answer",
            sdp: remoteOfferSdp,
          }),
        );
      } else {
        await pc.setLocalDescription({ type: "rollback" });
        await pc.setRemoteDescription(
          new RTCSessionDescription({
            type: "offer",
            sdp: remoteOfferSdp,
          }),
        );

        const localAnswer = await pc.createAnswer();
        await pc.setLocalDescription(localAnswer);
        await waitForIceGatheringComplete(pc, abortController.signal);

        const localAnswerSdp = pc.localDescription.sdp;
        if (!localAnswerSdp) {
          throw new Error("Failed to create local SDP answer");
        }

        const sessionUrl = new URL(resourceUrl);
        sessionUrl.pathname = sessionLocation;

        const patchResponse = await fetch(sessionUrl, {
          method: "PATCH",
          headers: {
            "Content-Type": "application/sdp",
          },
          body: localAnswerSdp,
          signal: abortController.signal,
        });
        if (!patchResponse.ok) {
          throw new Error(
            `Failed to submit SDP answer: ${String(patchResponse.status)}`,
          );
        }
      }
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }

      await this.disconnect({ notifyServer: false });
      this.setStatus("failed");
      throw normalizeError(error);
    } finally {
      if (this.connectAbortController === abortController) {
        this.connectAbortController = null;
      }
    }
  }

  async disconnect(options?: { notifyServer?: boolean }): Promise<void> {
    const notifyServer = options?.notifyServer ?? true;

    if (this.connectAbortController) {
      this.connectAbortController.abort();
      this.connectAbortController = null;
    }

    const currentSessionLocation = this.sessionLocation;
    this.sessionLocation = null;

    if (notifyServer && currentSessionLocation) {
      const sessionUrl = new URL(
        currentSessionLocation,
        window.location.origin,
      );
      try {
        await fetch(sessionUrl, { method: "DELETE" });
      } catch (error) {
        console.warn("Failed to close WHEP session:", error);
      }
    }

    if (this.pc) {
      this.cleanupEventListeners();
      this.pc.close();
      this.pc = null;
    }

    if (this.remoteStream) {
      this.remoteStream.getTracks().forEach((track) => {
        track.stop();
      });
      this.remoteStream = null;
    }

    this.videoElement.srcObject = null;
    this.setStreamState(false);
    this.setStatus("disconnected");
  }

  async dispose(): Promise<void> {
    await this.disconnect();
  }
}
