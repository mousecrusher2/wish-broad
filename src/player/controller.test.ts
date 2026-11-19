import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  WHEPPlaybackController,
  type WHEPPlaybackControllerSnapshot,
} from "./controller";

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

type FakeReceiver = {
  getStats: () => Promise<{
    forEach: (callback: (report: unknown) => void) => void;
  }>;
  track: { id: string; kind: string };
};

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
  /** 映像レシーバーの bytesReceived を返す。null の間はレシーバーが統計情報に現れない。 */
  readInboundBytes: (() => number) | null = null;
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

  getReceivers(): FakeReceiver[] {
    const readInboundBytes = this.readInboundBytes;
    if (readInboundBytes === null) {
      return [];
    }

    return [
      {
        getStats: async () => ({
          forEach: (callback) => {
            callback({
              bytesReceived: readInboundBytes(),
              type: "inbound-rtp",
            });
          },
        }),
        track: { id: "video-track", kind: "video" },
      },
    ];
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
  assert.isDefined(pc, "Expected a peer connection");
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
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- コントローラーは srcObject/play を WHEPSession に転送するだけ。
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
        expect(snapshots.at(-1)?.playbackState.phase).toBe("error");
      });

      expect(snapshots.at(-1)).toMatchObject({
        isLoading: false,
        playbackState: { phase: "error", resourceUserId: "alice" },
      });
      // 失敗したセッションはローカルで閉じるだけで、Worker には DELETE を送らない。
      expect(lastPeer().signalingState).toBe("closed");
      expect(requests).toEqual([
        { method: "POST", url: `${ORIGIN}/play/alice` },
      ]);
    },
  );

  it.each([502, 503])(
    "handles a rejected %i offer once even though the session also reports failed",
    async (status) => {
      const requests = mockPlayEndpoint(status);
      const { controller, snapshots } = createController();

      await controller.load("alice");
      await vi.advanceTimersByTimeAsync(5_000);

      expect(snapshots.at(-1)?.playbackState.phase).toBe("error");
      expect(console.error).toHaveBeenCalledOnce();
      expect(countPosts(requests)).toBe(1);
    },
  );

  it("keeps reconnecting when ICE fails on a retry attempt", async () => {
    const requests = mockPlayEndpoint();
    const { controller, snapshots } = createController();

    await controller.load("alice");
    const first = lastPeer();
    first.updateStates(ICE_CONNECTED);
    // 確立済みセッションは、リカバリー猶予期間の経過後に置き換えられる。
    first.updateStates(ICE_FAILED);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => {
      expect(lastPeer().remoteDescriptionApplied).toBe(true);
      expect(lastPeer()).not.toBe(first);
    });

    lastPeer().updateStates(ICE_FAILED);
    // 次のオファー送信までの 2 秒間のリトライ間隔を検証する。
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.waitFor(() => {
      expect(countPosts(requests)).toBe(3);
    });

    expect(requests.map((request) => request.method)).not.toContain("DELETE");
    expect(snapshots.at(-1)?.playbackState.phase).toBe("reconnecting");
  });

  it("replaces the session once inbound media stops flowing", async () => {
    const requests = mockPlayEndpoint();
    const { controller, snapshots } = createController();

    await controller.load("alice");
    const first = lastPeer();
    first.readInboundBytes = () => 100;
    first.updateStates(ICE_CONNECTED);
    // 1 秒後の読み取りでレシーバーが揃い、その後 bytesReceived が 3 秒間増えない。
    await vi.advanceTimersByTimeAsync(3_999);
    expect(countPosts(requests)).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(countPosts(requests)).toBe(2);
    });
    expect(first.signalingState).toBe("closed");
    expect(requests.map((request) => request.method)).not.toContain("DELETE");
    expect(snapshots.map((snapshot) => snapshot.playbackState.phase)).toContain(
      "reconnecting",
    );
  });

  it("keeps the session while inbound bytes keep growing", async () => {
    const requests = mockPlayEndpoint();
    const { controller, snapshots } = createController();
    let bytesReceived = 0;

    await controller.load("alice");
    lastPeer().readInboundBytes = () => {
      bytesReceived += 100;
      return bytesReceived;
    };
    lastPeer().updateStates(ICE_CONNECTED);
    // レシーバーが揃った後は、トラック検出の期限（15 秒）を過ぎても作り直さない。
    await vi.advanceTimersByTimeAsync(20_000);

    expect(requests).toEqual([{ method: "POST", url: `${ORIGIN}/play/alice` }]);
    expect(snapshots.at(-1)?.playbackState.phase).toBe("connected");
  });

  it("replaces a session whose receivers never appear in the stats", async () => {
    const requests = mockPlayEndpoint();
    const { controller } = createController();

    await controller.load("alice");
    lastPeer().updateStates(ICE_CONNECTED);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(countPosts(requests)).toBe(1);

    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => {
      expect(countPosts(requests)).toBe(2);
    });
  });

  it("waits for the publisher on an initial load that gets 409", async () => {
    const requests = mockPlayEndpoint((postIndex) =>
      postIndex < 2 ? 409 : 201,
    );
    const { controller, snapshots } = createController();

    await controller.load("alice");

    expect(snapshots.at(-1)).toMatchObject({
      isLoading: false,
      playbackState: { phase: "reconnecting", resourceUserId: "alice" },
    });
    // オファーはバックオフせず、固定の 2 秒間隔でリトライされる。
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
      postIndex === 0 || Date.now() >= publisherBackAt ? 201 : 409,
    );
    const { controller, snapshots } = createController();

    await controller.load("alice");
    lastPeer().updateStates(ICE_CONNECTED);
    lastPeer().updateStates(ICE_FAILED);
    await vi.advanceTimersByTimeAsync(3_000 + 59_000);

    expect(snapshots.at(-1)?.playbackState.phase).toBe("reconnecting");
    const postsDuringGrace = countPosts(requests);

    // 配信者が戻った後の 2 秒間のリトライ間隔を検証する。
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => {
      expect(countPosts(requests)).toBeGreaterThan(postsDuringGrace);
      expect(lastPeer().remoteDescriptionApplied).toBe(true);
    });
    lastPeer().updateStates(ICE_CONNECTED);

    expect(snapshots.at(-1)?.playbackState.phase).toBe("connected");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("gives up with an error when the publisher never reconnects", async () => {
    mockPlayEndpoint((postIndex) => (postIndex === 0 ? 201 : 409));
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

  it("gives up when reconnected sessions connect but never receive media", async () => {
    const requests = mockPlayEndpoint();
    onRemoteDescription = (pc) => {
      pc.updateStates(ICE_CONNECTED);
    };
    const { controller, snapshots } = createController();

    await controller.load("alice");
    // レシーバーが揃わないまま約 15 秒ごとに作り直し、最初の作り直しから 75 秒で諦める。
    await vi.advanceTimersByTimeAsync(15_000 + 70_000);
    expect(snapshots.at(-1)?.playbackState.phase).not.toBe("error");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(snapshots.at(-1)?.playbackState.phase).toBe("error");
    expect(console.error).toHaveBeenCalledWith(
      "WHEP playback failed:",
      new Error("WHEP reconnect window expired"),
    );
    const postsAtGiveUp = countPosts(requests);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(countPosts(requests)).toBe(postsAtGiveUp);
  });

  it("restarts the reconnect window once media flows on a reconnected session", async () => {
    const requests = mockPlayEndpoint();
    let bytesReceived = 0;
    let mediaFlowing = true;
    onRemoteDescription = (pc) => {
      pc.readInboundBytes = () => {
        if (mediaFlowing) {
          bytesReceived += 100;
        }
        return bytesReceived;
      };
      pc.updateStates(ICE_CONNECTED);
    };
    const { controller, snapshots } = createController();

    await controller.load("alice");
    await vi.advanceTimersByTimeAsync(2_000);
    mediaFlowing = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(countPosts(requests)).toBe(2);
    });

    // 置き換えたセッションで最初の時間枠（75 秒）を過ぎるまでメディアが流れた後、再び止まる。
    mediaFlowing = true;
    await vi.advanceTimersByTimeAsync(90_000);
    mediaFlowing = false;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => {
      expect(countPosts(requests)).toBe(3);
    });

    expect(snapshots.at(-1)?.playbackState.phase).not.toBe("error");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("waits out a grace period that starts after media-less reconnects", async () => {
    const startedAt = Date.now();
    // 配信者が DELETE なしで落ち、SFU が回収するまでは 201 だがメディアは届かない。
    // その後 Worker が猶予期間を始めて 409 を返し、猶予期間の終了後は 404 を返す。
    mockPlayEndpoint((postIndex) => {
      const elapsed = Date.now() - startedAt;
      if (postIndex === 0 || elapsed < 40_000) {
        return 201;
      }
      return elapsed < 110_000 ? 409 : 404;
    });
    let bytesReceived = 0;
    onRemoteDescription = (pc) => {
      if (FakePeerConnection.instances.length === 1) {
        pc.readInboundBytes = () => {
          if (Date.now() - startedAt < 2_000) {
            bytesReceived += 100;
          }
          return bytesReceived;
        };
      }
      pc.updateStates(ICE_CONNECTED);
    };
    const { controller, snapshots } = createController();

    await controller.load("alice");
    await vi.advanceTimersByTimeAsync(115_000);

    expect(snapshots.at(-1)?.playbackState.phase).toBe("ended");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("does not give up at once when a session that connected while hidden fails later", async () => {
    const requests = mockPlayEndpoint();
    const { controller, snapshots } = createController();

    await controller.load("alice");
    const first = lastPeer();
    first.updateStates(ICE_CONNECTED);
    first.updateStates(ICE_FAILED);
    // ここから再接続の時間枠が始まり、置き換えたセッションは非表示の間に接続する。
    Object.assign(document, { visibilityState: "hidden" });
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => {
      expect(lastPeer()).not.toBe(first);
      expect(lastPeer().remoteDescriptionApplied).toBe(true);
    });
    lastPeer().updateStates(ICE_CONNECTED);

    // 時間枠（75 秒）を過ぎてから ICE が失敗しても、すぐには諦めずに再接続する。
    await vi.advanceTimersByTimeAsync(100_000);
    lastPeer().updateStates(ICE_FAILED);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.waitFor(() => {
      expect(countPosts(requests)).toBe(3);
    });

    expect(snapshots.at(-1)?.playbackState.phase).not.toBe("error");
    expect(console.error).not.toHaveBeenCalled();
  });
});
