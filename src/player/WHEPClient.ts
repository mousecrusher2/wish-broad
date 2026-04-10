export type WHEPConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed";

type WHEPSessionCallbacks = {
  onStatusChange?: (status: WHEPConnectionStatus) => void;
  onStreamChange?: (hasStream: boolean) => void;
};

type WHEPSessionOptions = {
  callbacks?: WHEPSessionCallbacks;
  resourceUserId: string;
  videoElement: HTMLVideoElement;
};

type ServerSessionState =
  | { kind: "pending" }
  | { kind: "registered"; location: string };

type WhepSessionResponse =
  | { kind: "accepted"; sdp: string; sessionUrl: URL }
  | { kind: "counterOffer"; sdp: string; sessionUrl: URL };

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

async function readSdpResponse(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("application/sdp")) {
    throw new Error("Unexpected WHEP SDP response content type");
  }

  const sdp = await response.text();
  if (sdp.trim().length === 0) {
    throw new Error("Empty SDP response");
  }

  return sdp;
}

async function parseWhepSessionResponse(
  response: Response,
  resourceUrl: URL,
): Promise<WhepSessionResponse> {
  if (response.status !== 201 && response.status !== 406) {
    throw new Error(
      `Unexpected WHEP session response: ${String(response.status)}`,
    );
  }

  const sessionLocation = response.headers.get("location");
  if (!sessionLocation) {
    throw new Error("Missing WHEP session location header");
  }

  const sessionUrl = new URL(sessionLocation, resourceUrl);
  const sdp = await readSdpResponse(response);

  if (response.status === 406) {
    return { kind: "counterOffer", sdp, sessionUrl };
  }

  return { kind: "accepted", sdp, sessionUrl };
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

export class WHEPSession {
  private readonly abortController = new AbortController();
  private readonly callbacks: WHEPSessionCallbacks;
  private readonly eventListenerCleanups: Array<() => void> = [];
  private readonly pc = new RTCPeerConnection({ bundlePolicy: "max-bundle" });
  private readonly remoteStream = new MediaStream();
  private readonly remoteTrackCleanups = new Map<
    MediaStreamTrack,
    () => void
  >();
  private readonly resourceUserId: string;
  private readonly videoElement: HTMLVideoElement;
  private cleanupPromise: Promise<void> | null = null;
  private disposed = false;
  private hasStream = false;
  private localResourcesReleased = false;
  private registrationPromise: Promise<WhepSessionResponse> | null = null;
  private serverSession: ServerSessionState = { kind: "pending" };
  private status: WHEPConnectionStatus = "disconnected";

  constructor({
    callbacks = {},
    resourceUserId,
    videoElement,
  }: WHEPSessionOptions) {
    const trimmedResourceUserId = resourceUserId.trim();
    if (trimmedResourceUserId.length === 0) {
      throw new Error("Resource user id is required");
    }

    this.callbacks = callbacks;
    this.resourceUserId = trimmedResourceUserId;
    this.videoElement = videoElement;
    this.videoElement.srcObject = this.remoteStream;

    this.attachConnectionListeners();
    this.attachTrackListener();
    this.attachMediaStreamListeners();
    this.pc.addTransceiver("video", { direction: "recvonly" });
    this.pc.addTransceiver("audio", { direction: "recvonly" });
  }

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
  ): WHEPConnectionStatus {
    switch (state) {
      case "new":
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
      default:
        return assertUnreachableState(this.pc.connectionState);
    }
  }

  private refreshConnectionStatus(): void {
    if (this.disposed) {
      return;
    }

    const nextStatus = this.deriveConnectionStatus();
    this.setStatus(nextStatus);

    if (nextStatus === "failed" || nextStatus === "disconnected") {
      this.setStreamState(false);
      return;
    }

    this.refreshStreamState();
  }

  private refreshStreamState(): void {
    if (this.disposed) {
      this.setStreamState(false);
      return;
    }

    const hasLiveUnmutedTrack = this.remoteStream.getTracks().some((track) => {
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
      if (this.disposed) {
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
      if (this.disposed) {
        return;
      }

      this.attachRemoteTrackListeners(event.track);
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

  private attachMediaStreamListeners(): void {
    this.addMediaStreamListener("addtrack", (event) => {
      if (this.disposed) {
        return;
      }

      this.attachRemoteTrackListeners(event.track);
      this.refreshStreamState();
    });

    this.addMediaStreamListener("removetrack", (event) => {
      if (this.disposed) {
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
    this.remoteTrackCleanups.get(track)?.();
  }

  private releaseLocalResources(): void {
    if (this.localResourcesReleased) {
      return;
    }

    this.localResourcesReleased = true;
    this.cleanupEventListeners();
    this.pc.close();

    this.remoteStream.getTracks().forEach((track) => {
      track.stop();
    });

    this.videoElement.srcObject = null;
    this.setStreamState(false);
    this.setStatus("disconnected");
  }

  private async deleteRegisteredSession(): Promise<void> {
    if (this.serverSession.kind !== "registered") {
      return;
    }

    const sessionUrl = new URL(
      this.serverSession.location,
      window.location.origin,
    );
    try {
      await fetch(sessionUrl, { method: "DELETE" });
    } catch (error) {
      console.warn("Failed to close WHEP session:", error);
    }
  }

  private async cleanupServerSession(): Promise<void> {
    const registrationResult = this.registrationPromise
      ? await this.registrationPromise.catch(() => null)
      : null;

    if (
      this.serverSession.kind !== "registered" &&
      registrationResult !== null
    ) {
      this.serverSession = {
        kind: "registered",
        location: registrationResult.sessionUrl.toString(),
      };
    }

    await this.deleteRegisteredSession();
  }

  async start(): Promise<void> {
    this.setStatus("connecting");
    this.setStreamState(false);

    try {
      const resourceUrl = new URL(
        `/play/${encodeURIComponent(this.resourceUserId)}`,
        window.location.origin,
      );

      const localOffer = await this.pc.createOffer();
      await this.pc.setLocalDescription(localOffer);
      await waitForIceGatheringComplete(this.pc, this.abortController.signal);

      const localOfferSdp = this.pc.localDescription?.sdp;
      if (!localOfferSdp) {
        throw new Error("Failed to create local SDP offer");
      }

      this.registrationPromise = fetch(resourceUrl, {
        method: "POST",
        headers: {
          Accept: "application/sdp",
          "Content-Type": "application/sdp",
        },
        body: localOfferSdp,
      }).then((offerResponse) =>
        parseWhepSessionResponse(offerResponse, resourceUrl),
      );
      const sessionResponse = await this.registrationPromise;
      this.serverSession = {
        kind: "registered",
        location: sessionResponse.sessionUrl.toString(),
      };

      if (this.disposed) {
        return;
      }

      if (sessionResponse.kind === "accepted") {
        await this.pc.setRemoteDescription(
          new RTCSessionDescription({
            type: "answer",
            sdp: sessionResponse.sdp,
          }),
        );
      } else {
        await this.pc.setLocalDescription({ type: "rollback" });
        await this.pc.setRemoteDescription(
          new RTCSessionDescription({
            type: "offer",
            sdp: sessionResponse.sdp,
          }),
        );

        const localAnswer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(localAnswer);
        await waitForIceGatheringComplete(this.pc, this.abortController.signal);

        const localAnswerSdp = this.pc.localDescription.sdp;
        if (!localAnswerSdp) {
          throw new Error("Failed to create local SDP answer");
        }

        const patchResponse = await fetch(sessionResponse.sessionUrl, {
          method: "PATCH",
          headers: {
            Accept: "application/sdp",
            "Content-Type": "application/sdp",
          },
          body: localAnswerSdp,
          signal: this.abortController.signal,
        });
        if (patchResponse.status !== 204) {
          throw new Error(
            `Unexpected WHEP answer response: ${String(patchResponse.status)}`,
          );
        }
      }
    } catch (error) {
      if (this.abortController.signal.aborted || this.disposed) {
        return;
      }

      await this.dispose({ notifyServer: true });
      this.setStatus("failed");
      throw normalizeError(error);
    }
  }

  async dispose(options?: { notifyServer?: boolean }): Promise<void> {
    const notifyServer = options?.notifyServer ?? true;

    if (this.cleanupPromise) {
      await this.cleanupPromise;
      return;
    }

    this.disposed = true;
    this.abortController.abort();
    this.releaseLocalResources();
    this.cleanupPromise = notifyServer
      ? this.cleanupServerSession()
      : Promise.resolve();
    await this.cleanupPromise;
  }
}
