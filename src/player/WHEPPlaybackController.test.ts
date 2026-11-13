import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WHEPPlaybackController,
  type WHEPPlaybackControllerSnapshot,
} from "./WHEPPlaybackController";

vi.mock("./turn-credentials", () => ({
  fetchTurnIceServers: async () => null,
}));

const ORIGIN = "http://localhost";
const ICE_FAILED = {
  connectionState: "failed",
  iceConnectionState: "failed",
} as const;
const ICE_CONNECTED = {
  connectionState: "connected",
  iceConnectionState: "connected",
} as const;

type ConnectionStates = Partial<{
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
}>;

type RequestRecord = { method: string; url: string };

let onRemoteDescription: (pc: FakePeerConnection) => void = () => undefined;

class FakeMediaStream extends EventTarget {
  getTracks(): MediaStreamTrack[] {
    return [];
  }

  addTrack(): void {}
}

class FakePeerConnection extends EventTarget {
  static readonly instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescriptionApplied = false;

  constructor() {
    super();
    FakePeerConnection.instances.push(this);
  }

  addTransceiver(): void {}

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    return { sdp: "local-offer", type: "offer" };
  }

  async setLocalDescription(
    description: RTCSessionDescriptionInit,
  ): Promise<void> {
    this.localDescription = description;
  }

  async setRemoteDescription(): Promise<void> {
    this.remoteDescriptionApplied = true;
    onRemoteDescription(this);
  }

  close(): void {
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
    this.signalingState = "closed";
  }

  getConfiguration(): RTCConfiguration {
    return {};
  }

  setConfiguration(): void {}

  getReceivers(): RTCRtpReceiver[] {
    return [];
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return [];
  }

  updateStates(states: ConnectionStates): void {
    Object.assign(this, states);
    this.dispatchEvent(new Event("iceconnectionstatechange"));
  }
}

class FakeSessionDescription {
  readonly sdp: string;
  readonly type: RTCSdpType;

  constructor(init: RTCSessionDescriptionInit) {
    this.sdp = init.sdp ?? "";
    this.type = init.type;
  }
}

function lastPeer(): FakePeerConnection {
  const pc = FakePeerConnection.instances.at(-1);
  if (pc === undefined) {
    throw new Error("Expected a peer connection");
  }
  return pc;
}

function mockPlayEndpoint(
  offerStatus: number | ((postIndex: number) => number) = 201,
): RequestRecord[] {
  const requests: RequestRecord[] = [];
  let sessionCount = 0;
  let postCount = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = init?.method ?? "GET";
    requests.push({ method, url });

    if (method !== "POST") {
      return new Response(null, { status: 200 });
    }
    const status =
      typeof offerStatus === "number" ? offerStatus : offerStatus(postCount);
    postCount += 1;
    if (status !== 201) {
      return new Response("unavailable", { status });
    }

    sessionCount += 1;
    return new Response("remote-answer", {
      headers: {
        "Content-Type": "application/sdp",
        Location: `/play/alice/session-${String(sessionCount)}?mid=0`,
        "Wish-Live-Track-Count": "1",
      },
      status: 201,
    });
  });
  return requests;
}

function countPosts(requests: RequestRecord[]): number {
  return requests.filter((request) => request.method === "POST").length;
}

function createController() {
  const snapshots: WHEPPlaybackControllerSnapshot[] = [];
  const controller = new WHEPPlaybackController();
  controller.setSnapshotSubscriber((snapshot) => {
    snapshots.push(snapshot);
  });
  const videoElement: Pick<HTMLVideoElement, "play" | "srcObject"> = {
    play: async () => undefined,
    srcObject: null,
  };
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- The controller only forwards srcObject/play to WHEPSession.
  void controller.attachVideoElement(videoElement as HTMLVideoElement);
  return { controller, snapshots };
}

describe("WHEPPlaybackController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakePeerConnection.instances.length = 0;
    onRemoteDescription = () => undefined;
    vi.stubGlobal("window", {
      clearInterval: (id?: number) => {
        globalThis.clearInterval(id);
      },
      clearTimeout: (id?: number) => {
        globalThis.clearTimeout(id);
      },
      location: { origin: ORIGIN },
      setInterval: (handler: () => void, timeout?: number) =>
        globalThis.setInterval(handler, timeout),
      setTimeout: (handler: () => void, timeout?: number) =>
        globalThis.setTimeout(handler, timeout),
    });
    vi.stubGlobal("document", {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      visibilityState: "visible",
    });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal("MediaStream", FakeMediaStream);
    vi.stubGlobal("RTCSessionDescription", FakeSessionDescription);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    ["after signaling completes", false],
    ["while signaling is still in flight", true],
  ] as const)(
    "ends an initial load with an error when ICE fails %s",
    async (_label, failDuringSignaling) => {
      const requests = mockPlayEndpoint();
      if (failDuringSignaling) {
        onRemoteDescription = (pc) => {
          pc.updateStates(ICE_FAILED);
        };
      }
      const { controller, snapshots } = createController();

      await controller.load("alice");
      if (!failDuringSignaling) {
        lastPeer().updateStates(ICE_FAILED);
      }
      await vi.waitFor(() => {
        expect(requests).toHaveLength(2);
      });

      expect(snapshots.at(-1)).toMatchObject({
        isLoading: false,
        playbackState: { phase: "error", resourceUserId: "alice" },
      });
      expect(requests).toEqual([
        { method: "POST", url: `${ORIGIN}/play/alice` },
        { method: "DELETE", url: `${ORIGIN}/play/alice/session-1?mid=0` },
      ]);
    },
  );

  it("handles a rejected offer once even though the session also reports failed", async () => {
    const requests = mockPlayEndpoint(502);
    const { controller, snapshots } = createController();

    await controller.load("alice");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(snapshots.at(-1)?.playbackState.phase).toBe("error");
    expect(console.error).toHaveBeenCalledOnce();
    expect(countPosts(requests)).toBe(1);
  });

  it("keeps reconnecting when ICE fails on a retry attempt", async () => {
    const requests = mockPlayEndpoint();
    const { controller, snapshots } = createController();

    await controller.load("alice");
    const first = lastPeer();
    first.updateStates(ICE_CONNECTED);
    // The established session is replaced after its recovery grace period.
    first.updateStates(ICE_FAILED);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => {
      expect(lastPeer().remoteDescriptionApplied).toBe(true);
      expect(lastPeer()).not.toBe(first);
    });

    lastPeer().updateStates(ICE_FAILED);
    // Covers the 2 s retry interval before the next offer.
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(countPosts(requests)).toBe(3);
    });

    expect(requests).toContainEqual({
      method: "DELETE",
      url: `${ORIGIN}/play/alice/session-2?mid=0`,
    });
    expect(snapshots.at(-1)?.playbackState.phase).toBe("reconnecting");
  });

  it("waits for the publisher on an initial load that gets 503", async () => {
    const requests = mockPlayEndpoint((postIndex) =>
      postIndex < 2 ? 503 : 201,
    );
    const { controller, snapshots } = createController();

    await controller.load("alice");

    expect(snapshots.at(-1)).toMatchObject({
      isLoading: false,
      playbackState: { phase: "reconnecting", resourceUserId: "alice" },
    });
    // Offers are retried at a fixed 2 s interval, without backing off.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(countPosts(requests)).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(countPosts(requests)).toBe(2);
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(countPosts(requests)).toBe(3);
      expect(lastPeer().remoteDescriptionApplied).toBe(true);
    });
    lastPeer().updateStates(ICE_CONNECTED);

    expect(snapshots.at(-1)?.playbackState.phase).toBe("connected");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("ends playback at once when a reconnect gets 404", async () => {
    const requests = mockPlayEndpoint((postIndex) =>
      postIndex === 0 ? 201 : 404,
    );
    const { controller, snapshots } = createController();

    await controller.load("alice");
    lastPeer().updateStates(ICE_CONNECTED);
    lastPeer().updateStates(ICE_FAILED);
    await vi.advanceTimersByTimeAsync(3_000);

    await vi.waitFor(() => {
      expect(snapshots.at(-1)?.playbackState.phase).toBe("ended");
    });
    expect(countPosts(requests)).toBe(2);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("keeps reconnecting through the publisher's 60 second grace period", async () => {
    const publisherBackAt = Date.now() + 3_000 + 60_000;
    const requests = mockPlayEndpoint((postIndex) =>
      postIndex === 0 || Date.now() >= publisherBackAt ? 201 : 503,
    );
    const { controller, snapshots } = createController();

    await controller.load("alice");
    lastPeer().updateStates(ICE_CONNECTED);
    lastPeer().updateStates(ICE_FAILED);
    await vi.advanceTimersByTimeAsync(3_000 + 59_000);

    expect(snapshots.at(-1)?.playbackState.phase).toBe("reconnecting");
    const postsDuringGrace = countPosts(requests);

    // Covers the 2 s retry interval once the publisher is back.
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => {
      expect(countPosts(requests)).toBeGreaterThan(postsDuringGrace);
      expect(lastPeer().remoteDescriptionApplied).toBe(true);
    });
    lastPeer().updateStates(ICE_CONNECTED);

    expect(snapshots.at(-1)?.playbackState.phase).toBe("connected");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("gives up with an error when the server stays unavailable", async () => {
    mockPlayEndpoint((postIndex) => (postIndex === 0 ? 201 : 503));
    const { controller, snapshots } = createController();

    await controller.load("alice");
    lastPeer().updateStates(ICE_CONNECTED);
    lastPeer().updateStates(ICE_FAILED);
    await vi.advanceTimersByTimeAsync(3_000 + 74_000);
    expect(snapshots.at(-1)?.playbackState.phase).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(2_000);

    expect(snapshots.at(-1)?.playbackState.phase).toBe("error");
    expect(console.error).toHaveBeenCalledWith(
      "WHEP playback failed:",
      new Error("WHEP reconnect window expired"),
    );
  });
});
