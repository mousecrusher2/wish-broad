export type WHEPConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed";

type WHEPClientCallbacks = {
  onStatusChange?: (status: WHEPConnectionStatus) => void;
  onStreamChange?: (hasStream: boolean) => void;
};

function assertUnreachableConnectionState(state: never): never {
  void state;
  throw new Error("Unexpected connection state");
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

async function waitForIceGatheringComplete(
  pc: RTCPeerConnection,
): Promise<void> {
  if (pc.iceGatheringState === "complete") {
    return;
  }

  await new Promise<void>((resolve) => {
    const onGatheringStateChange = () => {
      if (pc.iceGatheringState === "complete") {
        pc.removeEventListener(
          "icegatheringstatechange",
          onGatheringStateChange,
        );
        resolve();
      }
    };

    pc.addEventListener("icegatheringstatechange", onGatheringStateChange);
  });
}

export class WHEPClient {
  private pc: RTCPeerConnection | null = null;
  private remoteStream: MediaStream | null = null;
  private status: WHEPConnectionStatus = "disconnected";
  private connectAbortController: AbortController | null = null;
  private sessionLocation: string | null = null;

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
    this.callbacks.onStreamChange?.(hasStream);
  }

  private attachConnectionListeners(pc: RTCPeerConnection): void {
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) {
        return;
      }

      switch (pc.connectionState) {
        case "new":
          this.setStatus("disconnected");
          this.setStreamState(false);
          break;
        case "connected":
          this.setStatus("connected");
          break;
        case "connecting":
          this.setStatus("connecting");
          break;
        case "failed":
          this.setStatus("failed");
          break;
        case "disconnected":
        case "closed":
          this.setStatus("disconnected");
          this.setStreamState(false);
          break;
        default:
          assertUnreachableConnectionState(pc.connectionState);
      }
    };
  }

  private attachTrackListener(pc: RTCPeerConnection): void {
    pc.ontrack = (event) => {
      if (this.pc !== pc || !this.remoteStream) {
        return;
      }

      this.remoteStream.addTrack(event.track);

      if (this.videoElement.srcObject !== this.remoteStream) {
        this.videoElement.srcObject = this.remoteStream;
      }

      this.setStreamState(true);
      void this.videoElement.play().catch((error) => {
        console.warn("Autoplay failed:", error);
      });
    };
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

      pc.addTransceiver("video", { direction: "recvonly" });
      pc.addTransceiver("audio", { direction: "recvonly" });

      const localOffer = await pc.createOffer();
      await pc.setLocalDescription(localOffer);
      await waitForIceGatheringComplete(pc);

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
        await waitForIceGatheringComplete(pc);

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
      this.pc.ontrack = null;
      this.pc.onconnectionstatechange = null;
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
