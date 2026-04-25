import { err, ok, type Result } from "neverthrow";
import { fetchTurnIceServers } from "./turn-credentials";

export type WHEPConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed";

type WHEPSessionRequestStage = "post" | "patch" | "delete" | "local";

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

type WHEPSessionOptions = {
  callbacks?: WHEPSessionCallbacks;
  resourceUserId: string;
  videoElement: HTMLVideoElement;
};

type ServerSessionState =
  | { kind: "idle" }
  | { kind: "registering"; promise: Promise<WhepSessionResponse> }
  | { kind: "registered"; location: string };

type WhepSessionResponse =
  | {
      expectedRemoteTrackCount: number | null;
      kind: "accepted";
      sdp: string;
      sessionUrl: URL;
    }
  | {
      expectedRemoteTrackCount: number | null;
      kind: "counterOffer";
      sdp: string;
      sessionUrl: URL;
    };

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
      this.kind === "resource_not_found" || this.kind === "client_request_error"
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
  const expectedRemoteTrackCountHeader = response.headers.get(
    "Wish-Live-Track-Count",
  );
  const parsedExpectedRemoteTrackCount =
    expectedRemoteTrackCountHeader === null
      ? null
      : Number.parseInt(expectedRemoteTrackCountHeader, 10);
  if (expectedRemoteTrackCountHeader !== null) {
    if (
      !Number.isInteger(parsedExpectedRemoteTrackCount) ||
      parsedExpectedRemoteTrackCount === null ||
      parsedExpectedRemoteTrackCount < 1
    ) {
      throw new WHEPSessionError("Invalid Wish-Live-Track-Count header", {
        kind: "unexpected_response",
        responseText: expectedRemoteTrackCountHeader,
        retryable: false,
        stage: "post",
      });
    }
  }
  const expectedRemoteTrackCount: number | null =
    expectedRemoteTrackCountHeader === null
      ? null
      : parsedExpectedRemoteTrackCount;
  const sdp = await readSdpResponse(response);

  if (response.status === 406) {
    return { expectedRemoteTrackCount, kind: "counterOffer", sdp, sessionUrl };
  }

  return { expectedRemoteTrackCount, kind: "accepted", sdp, sessionUrl };
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
  private expectedRemoteTrackCount = 0;
  private lifecycle: WHEPSessionLifecycle = { kind: "active" };
  private maxRemoteTrackCount = 0;
  private runtimeState: WHEPSessionRuntimeState =
    createRuntimeState("disconnected");
  private serverSession: ServerSessionState = { kind: "idle" };

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

  private isActive(): boolean {
    return this.lifecycle.kind === "active";
  }

  private setStatus(nextStatus: WHEPConnectionStatus): void {
    const previousState = this.runtimeState;
    const nextState = createRuntimeState(nextStatus, previousState);
    if (
      previousState.status === nextState.status &&
      previousState.hasStream === nextState.hasStream
    ) {
      return;
    }

    this.runtimeState = nextState;
    if (previousState.status !== nextState.status) {
      this.callbacks.onStatusChange?.(nextStatus);
    }
    if (previousState.hasStream !== nextState.hasStream) {
      this.callbacks.onStreamChange?.(nextState.hasStream);
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
          if (typeof nextBytesReceived === "number") {
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

    if (nextStatus === "failed" || nextStatus === "disconnected") {
      this.setStreamState(false);
      return;
    }

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
    this.remoteTrackCleanups.get(track)?.();
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
    // Dispose can run while POST /play is still in flight. If the Worker creates
    // a session before the abort reaches it, wait for the registration result so
    // the returned Location can still be DELETEd instead of leaking a Calls
    // playback session.
    if (this.serverSession.kind === "registering") {
      const registrationResult = await this.serverSession.promise.catch(
        () => null,
      );

      if (registrationResult !== null) {
        this.serverSession = {
          kind: "registered",
          location: registrationResult.sessionUrl.toString(),
        };
      }
    }

    await this.deleteRegisteredSession();
  }

  async start(): Promise<Result<void, Error>> {
    if (!this.isActive()) {
      return ok(undefined);
    }

    this.setStatus("connecting");

    const runStart = async (): Promise<Result<void, Error>> => {
      const resourceUrl = new URL(
        `/play/${encodeURIComponent(this.resourceUserId)}`,
        window.location.origin,
      );

      const turnIceServers = await fetchTurnIceServers(
        this.abortController.signal,
      );
      if (turnIceServers !== null) {
        this.pc.setConfiguration({
          ...this.pc.getConfiguration(),
          iceServers: turnIceServers,
        });
      }

      const localOffer = await this.pc.createOffer();
      await this.pc.setLocalDescription(localOffer);
      // The current Calls-backed Worker path is effectively non-trickle. Send a
      // complete local offer instead of relying on later trickle ICE PATCHes.
      await waitForIceGatheringComplete(this.pc, this.abortController.signal);

      const localOfferSdp = this.pc.localDescription?.sdp;
      if (!localOfferSdp) {
        throw new Error("Failed to create local SDP offer");
      }

      const registrationPromise = fetch(resourceUrl, {
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

          return parseWhepSessionResponse(
            offerResponseResult.value,
            resourceUrl,
          );
        });
      this.serverSession = {
        kind: "registering",
        promise: registrationPromise,
      };
      const sessionResponse = await registrationPromise;
      if (sessionResponse.expectedRemoteTrackCount !== null) {
        // Custom Worker header: expected ingest track count. It lets the
        // controller reject degraded playback that negotiates only a subset.
        this.expectedRemoteTrackCount =
          sessionResponse.expectedRemoteTrackCount;
      }
      this.serverSession = {
        kind: "registered",
        location: sessionResponse.sessionUrl.toString(),
      };

      if (!this.isActive()) {
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
        // This PATCH answers a WHEP 406 counter-offer. It is not a trickle ICE
        // candidate PATCH, so gather the full answer before sending.
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
      if (this.abortController.signal.aborted || !this.isActive()) {
        return ok(undefined);
      }

      await this.dispose({ notifyServer: true });
      this.setStatus("failed");
      return err(error);
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
      ? this.cleanupServerSession()
      : Promise.resolve();
    this.lifecycle = { cleanupPromise, kind: "closingServerSession" };

    try {
      await cleanupPromise;
    } finally {
      this.lifecycle = { kind: "disposed" };
    }
  }
}
