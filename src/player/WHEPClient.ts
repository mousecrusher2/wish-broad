import { err, ok, type Result } from "neverthrow";

export type WHEPConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed";

export type WHEPSessionRequestStage = "post" | "patch" | "delete" | "local";

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

type WHEPSessionErrorKind =
  | "resource_not_found"
  | "client_request_error"
  | "server_request_error"
  | "unexpected_response"
  | "invalid_sdp_response"
  | "missing_session_location"
  | "aborted";

type WHEPSessionErrorOptions = {
  kind: WHEPSessionErrorKind;
  responseText: string | undefined;
  retryable?: boolean;
  stage: WHEPSessionRequestStage;
};

export class WHEPSessionError extends Error {
  readonly kind: WHEPSessionErrorKind;
  readonly responseText: string | undefined;
  readonly retryable: boolean;
  readonly stage: WHEPSessionRequestStage;

  constructor(message: string, options: WHEPSessionErrorOptions) {
    super(message);
    this.name = "WHEPSessionError";
    this.kind = options.kind;
    this.responseText = options.responseText;
    this.retryable = options.retryable ?? true;
    this.stage = options.stage;
  }

  isNotFound(): boolean {
    return this.kind === "resource_not_found";
  }

  isClientRequestError(): boolean {
    return (
      this.kind === "resource_not_found" ||
      this.kind === "client_request_error"
    );
  }
}

async function readResponseText(
  response: Response,
): Promise<string | undefined> {
  return response
    .text()
    .then((responseText) =>
      responseText.trim().length > 0 ? responseText : undefined,
    )
    .catch(() => undefined);
}

async function createResponseError(
  response: Response,
  fallbackMessage: string,
  stage: WHEPSessionRequestStage,
): Promise<WHEPSessionError> {
  const responseText = await readResponseText(response);
  let kind: WHEPSessionErrorKind = "unexpected_response";
  if (response.status === 404) {
    kind = "resource_not_found";
  } else if (response.status >= 400 && response.status < 500) {
    kind = "client_request_error";
  } else if (response.status >= 500) {
    kind = "server_request_error";
  }

  return new WHEPSessionError(responseText ?? fallbackMessage, {
    kind,
    responseText,
    stage,
  });
}

async function readSdpResponse(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("application/sdp")) {
    throw new WHEPSessionError("Unexpected WHEP SDP response content type", {
      kind: "invalid_sdp_response",
      responseText: undefined,
      retryable: false,
      stage: "post",
    });
  }

  const sdp = await response.text();
  if (sdp.trim().length === 0) {
    throw new WHEPSessionError("Empty SDP response", {
      kind: "invalid_sdp_response",
      responseText: undefined,
      retryable: false,
      stage: "post",
    });
  }

  return sdp;
}

async function parseWhepSessionResponse(
  response: Response,
  resourceUrl: URL,
): Promise<WhepSessionResponse> {
  if (response.status !== 201 && response.status !== 406) {
    throw await createResponseError(
      response,
      `Unexpected WHEP session response: ${String(response.status)}`,
      "post",
    );
  }

  const sessionLocation = response.headers.get("location");
  if (!sessionLocation) {
    throw new WHEPSessionError("Missing WHEP session location header", {
      kind: "missing_session_location",
      responseText: undefined,
      retryable: false,
      stage: "post",
    });
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
  private maxRemoteTrackCount = 0;
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
        this.maxRemoteTrackCount,
        remoteTracks.length,
      ),
      hasStream: this.hasStream,
      iceConnectionState: this.pc.iceConnectionState,
      liveTrackCount,
      mutedTrackCount,
      remoteTrackCount: remoteTracks.length,
      signalingState: this.pc.signalingState,
      status: this.status,
    };
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
      void this.videoElement.play().catch((error: Error) => {
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
    const responseResult = await fetch(sessionUrl, { method: "DELETE" })
      .then((response) => ok(response))
      .catch((error: Error) => err(error));
    if (responseResult.isErr()) {
      console.warn("Failed to close WHEP session:", responseResult.error);
      return;
    }

    if (!responseResult.value.ok) {
      const responseError = await createResponseError(
        responseResult.value,
        `Unexpected WHEP delete response: ${String(responseResult.value.status)}`,
        "delete",
      );
      console.warn("Failed to close WHEP session:", responseError);
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

  async start(): Promise<Result<void, Error>> {
    this.setStatus("connecting");
    this.setStreamState(false);

    const runStart = async (): Promise<Result<void, Error>> => {
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
        signal: this.abortController.signal,
      })
        .then((offerResponse) => ok(offerResponse))
        .catch((error: Error) => err(error))
        .then((offerResponseResult) => {
          if (offerResponseResult.isErr()) {
            throw offerResponseResult.error;
          }

          return parseWhepSessionResponse(offerResponseResult.value, resourceUrl);
        });
      const sessionResponse = await this.registrationPromise;
      this.serverSession = {
        kind: "registered",
        location: sessionResponse.sessionUrl.toString(),
      };

      if (this.disposed) {
        return ok(undefined);
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

        const patchResponseResult = await fetch(sessionResponse.sessionUrl, {
          method: "PATCH",
          headers: {
            Accept: "application/sdp",
            "Content-Type": "application/sdp",
          },
          body: localAnswerSdp,
          signal: this.abortController.signal,
        })
          .then((response) => ok(response))
          .catch((error: Error) => err(error));
        if (patchResponseResult.isErr()) {
          throw patchResponseResult.error;
        }

        const patchResponse = patchResponseResult.value;
        if (patchResponse.status !== 204) {
          throw await createResponseError(
            patchResponse,
            `Unexpected WHEP answer response: ${String(patchResponse.status)}`,
            "patch",
          );
        }
      }
      return ok(undefined);
    };

    return runStart().catch(async (error: Error) => {
      if (this.abortController.signal.aborted || this.disposed) {
        return ok(undefined);
      }

      await this.dispose({ notifyServer: true });
      this.setStatus("failed");
      return err(error);
    });
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
