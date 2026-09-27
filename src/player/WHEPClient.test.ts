import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const turn = vi.hoisted(() => ({
  fetchTurnIceServers: vi.fn<() => Promise<RTCIceServer[] | null>>(),
}));
vi.mock("./turn-credentials", () => turn);

import { WHEPSession, WHEPSessionError } from "./WHEPClient";

class FakeTrack extends EventTarget {
  id: string;
  kind: string;
  muted = false;
  readyState = "live";
  stop = vi.fn<() => void>();
  constructor(id: string, kind = "video") {
    super();
    this.id = id;
    this.kind = kind;
  }
}

class FakeMediaStream extends EventTarget {
  tracks: FakeTrack[] = [];
  getTracks() {
    return [...this.tracks];
  }
  addTrack(track: FakeTrack) {
    this.tracks.push(track);
    const event = new Event("addtrack");
    Object.defineProperty(event, "track", { value: track });
    this.dispatchEvent(event);
  }
  removeTrack(track: FakeTrack) {
    this.tracks = this.tracks.filter((candidate) => candidate !== track);
    const event = new Event("removetrack");
    Object.defineProperty(event, "track", { value: track });
    this.dispatchEvent(event);
  }
}

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];
  connectionState = "new";
  iceConnectionState = "new";
  signalingState = "stable";
  iceGatheringState = "complete";
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  receivers: Array<{
    track: FakeTrack;
    getStats: () => Promise<Map<string, unknown>>;
  }> = [];
  transceivers: Array<{
    receiver: {
      track: FakeTrack;
      getStats: () => Promise<Map<string, unknown>>;
    };
    mid: string | null;
  }> = [];
  config = { bundlePolicy: "max-bundle", iceServers: [] as RTCIceServer[] };
  addTransceiver = vi.fn<(kind: string, init: unknown) => void>();
  createOffer = vi.fn(async () => ({ type: "offer", sdp: "local-offer" }));
  createAnswer = vi.fn(async () => ({ type: "answer", sdp: "local-answer" }));
  setLocalDescription = vi.fn(
    async (description: { type: string; sdp?: string }) => {
      this.localDescription =
        description.type === "rollback"
          ? null
          : { type: description.type, sdp: description.sdp ?? "" };
    },
  );
  setRemoteDescription = vi.fn(
    async (description: { type: string; sdp: string }) => {
      this.remoteDescription = description;
    },
  );
  getConfiguration = vi.fn(() => this.config);
  setConfiguration = vi.fn((config: typeof this.config) => {
    this.config = config;
  });
  getReceivers = vi.fn(() => this.receivers);
  getTransceivers = vi.fn(() => this.transceivers);
  close = vi.fn(() => {
    this.connectionState = "closed";
    this.signalingState = "closed";
  });
  constructor(_config: unknown) {
    super();
    FakePeerConnection.instances.push(this);
  }
}

function answer(
  body = "remote-answer",
  status = 201,
  headers: Record<string, string> = {},
) {
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/sdp",
      location: "/play/user/session-1",
      ...headers,
    },
  });
}

function createSession(resourceUserId = "user") {
  const video = {
    srcObject: null as unknown,
    play: vi.fn(async () => undefined),
  };
  const onStatusChange = vi.fn<(status: string) => void>();
  const onStreamChange = vi.fn<(hasStream: boolean) => void>();
  const session = new WHEPSession({
    resourceUserId,
    videoElement: video as unknown as HTMLVideoElement,
    callbacks: { onStatusChange, onStreamChange },
  });
  const pc = FakePeerConnection.instances.at(-1);
  if (!pc) throw new Error("Expected a peer connection");
  return { session, pc, video, onStatusChange, onStreamChange };
}

describe("WHEP browser session", () => {
  beforeEach(() => {
    FakePeerConnection.instances.length = 0;
    vi.stubGlobal("window", { location: { origin: "https://wish.test" } });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal("MediaStream", FakeMediaStream);
    vi.stubGlobal(
      "RTCSessionDescription",
      class {
        type: string;
        sdp: string;
        constructor(init: { type: string; sdp: string }) {
          this.type = init.type;
          this.sdp = init.sdp;
        }
      },
    );
    turn.fetchTurnIceServers.mockReset().mockResolvedValue(null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("validates the user id and prepares receive-only media", () => {
    expect(() => createSession("  ")).toThrow("Resource user id is required");
    const { session, pc, video } = createSession(" user / one ");
    expect(video.srcObject).toBeInstanceOf(FakeMediaStream);
    expect(pc.addTransceiver.mock.calls).toEqual([
      ["video", { direction: "recvonly" }],
      ["audio", { direction: "recvonly" }],
    ]);
    expect(session.getSnapshot()).toEqual({
      connectionState: "new",
      iceConnectionState: "new",
      signalingState: "stable",
      expectedRemoteTrackCount: 0,
      hasStream: false,
      liveTrackCount: 0,
      mutedTrackCount: 0,
      remoteTrackCount: 0,
      status: "disconnected",
    });
  });

  it("posts a full SDP offer, applies an answer, and deletes the registered session", async () => {
    turn.fetchTurnIceServers.mockResolvedValue([{ urls: "turn:example.net" }]);
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        answer("remote-answer", 201, { "Wish-Live-Track-Count": "2" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { session, pc, video, onStatusChange } = createSession();
    expect((await session.start(new AbortController().signal)).isOk()).toBe(
      true,
    );
    expect(turn.fetchTurnIceServers).toHaveBeenCalledWith(
      expect.any(AbortSignal),
    );
    expect(pc.setConfiguration).toHaveBeenCalledWith({
      bundlePolicy: "max-bundle",
      iceServers: [{ urls: "turn:example.net" }],
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      new URL("https://wish.test/play/user"),
      expect.objectContaining({
        method: "POST",
        body: "local-offer",
        headers: {
          Accept: "application/sdp",
          "Content-Type": "application/sdp",
        },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(pc.remoteDescription).toEqual({
      type: "answer",
      sdp: "remote-answer",
    });
    expect(session.getSnapshot().expectedRemoteTrackCount).toBe(2);
    expect(onStatusChange).toHaveBeenCalledWith("connecting");
    await session.dispose();
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      new URL("https://wish.test/play/user/session-1"),
      { method: "DELETE" },
    );
    expect(pc.close).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
  });

  it("answers a WHEP 406 counter-offer using PATCH", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(answer("remote-offer", 406))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { session, pc } = createSession();
    expect((await session.start(new AbortController().signal)).isOk()).toBe(
      true,
    );
    expect(pc.setLocalDescription).toHaveBeenCalledWith({ type: "rollback" });
    expect(pc.remoteDescription).toEqual({
      type: "offer",
      sdp: "remote-offer",
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      new URL("https://wish.test/play/user/session-1"),
      expect.objectContaining({ method: "PATCH", body: "local-answer" }),
    );
    await session.dispose();
  });

  it.each([
    [new Response("missing", { status: 404 }), "resource_not_found", "missing"],
    [
      new Response("invalid", { status: 400 }),
      "client_request_error",
      "invalid",
    ],
    [
      new Response("upstream", { status: 503 }),
      "server_request_error",
      "upstream",
    ],
    [answer("", 201), "invalid_sdp_response", "Empty SDP response"],
    [
      answer("answer", 201, { "content-type": "application/json" }),
      "invalid_sdp_response",
      "Unexpected WHEP SDP response content type",
    ],
    [
      answer("answer", 201, { location: "" }),
      "missing_session_location",
      "Missing WHEP session location header",
    ],
    [
      answer("answer", 201, { "Wish-Live-Track-Count": "0" }),
      "unexpected_response",
      "Invalid Wish-Live-Track-Count header",
    ],
  ])(
    "reports invalid WHEP POST responses (%s)",
    async (response, kind, message) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
      const { session } = createSession();
      const result = await session.start(new AbortController().signal);
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("Expected WHEP error");
      expect(result.error).toMatchObject({ kind, message, stage: "post" });
    },
  );

  it.each([
    [
      new Response("answer", {
        status: 201,
        headers: { location: "/play/user/session-1" },
      }),
      "Unexpected WHEP SDP response content type",
    ],
    [answer(" \n\t ", 201), "Empty SDP response"],
  ])(
    "rejects a missing media type or whitespace SDP (%s)",
    async (response, message) => {
      vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
      const { session, pc } = createSession();
      const result = await session.start(new AbortController().signal);
      expect(result._unsafeUnwrapErr()).toMatchObject({
        kind: "invalid_sdp_response",
        message,
        retryable: false,
        responseText: undefined,
        stage: "post",
      });
      expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    },
  );

  it("maps valid inbound RTP stats to receiver MIDs", async () => {
    const { session, pc } = createSession();
    const video = new FakeTrack("track-video");
    const audio = new FakeTrack("track-audio", "audio");
    const other = new FakeTrack("track-other", "data");
    const videoReceiver = {
      track: video,
      getStats: async () =>
        new Map<string, unknown>([
          ["junk", { type: "outbound-rtp", bytesReceived: 100 }],
          ["video", { type: "inbound-rtp", bytesReceived: 42 }],
        ]),
    };
    const audioReceiver = {
      track: audio,
      getStats: async () =>
        new Map<string, unknown>([
          ["audio", { type: "inbound-rtp", bytesReceived: 7 }],
        ]),
    };
    pc.receivers = [
      videoReceiver,
      audioReceiver,
      { track: other, getStats: async () => new Map() },
    ];
    pc.transceivers = [
      { receiver: videoReceiver, mid: "mid-1" },
      { receiver: audioReceiver, mid: null },
    ];
    expect(await session.getInboundReceiverStats()).toEqual([
      { id: "mid-1", kind: "video", bytesReceived: 42 },
      { id: "track-audio", kind: "audio", bytesReceived: 7 },
    ]);
  });

  it("updates snapshot and media callbacks when tracks arrive, mute, and end", async () => {
    const { session, pc, video, onStreamChange, onStatusChange } =
      createSession();
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    pc.dispatchEvent(new Event("connectionstatechange"));
    expect(session.getSnapshot().status).toBe("connected");
    const track = new FakeTrack("video-1");
    const event = new Event("track");
    Object.defineProperty(event, "track", { value: track });
    pc.dispatchEvent(event);
    expect(video.play).toHaveBeenCalledOnce();
    expect(session.getSnapshot()).toMatchObject({
      hasStream: true,
      liveTrackCount: 1,
      remoteTrackCount: 1,
      expectedRemoteTrackCount: 1,
    });
    expect(onStreamChange).toHaveBeenCalledWith(true);
    track.muted = true;
    track.dispatchEvent(new Event("mute"));
    expect(session.getSnapshot()).toMatchObject({
      hasStream: false,
      mutedTrackCount: 1,
    });
    track.muted = false;
    track.dispatchEvent(new Event("unmute"));
    expect(session.getSnapshot().hasStream).toBe(true);
    track.readyState = "ended";
    track.dispatchEvent(new Event("ended"));
    expect(session.getSnapshot().liveTrackCount).toBe(0);
    pc.iceConnectionState = "failed";
    pc.dispatchEvent(new Event("iceconnectionstatechange"));
    expect(session.getSnapshot().status).toBe("failed");
    expect(onStatusChange).toHaveBeenCalledWith("failed");
    await session.dispose({ notifyServer: false });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
  });

  it("does not issue requests when the attempt has already been aborted", async () => {
    const { session } = createSession();
    const controller = new AbortController();
    controller.abort();
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    expect((await session.start(controller.signal)).isOk()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    await session.dispose();
  });

  it("waits for ICE gathering and stops startup when the attempt aborts", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    const { session, pc } = createSession();
    pc.iceGatheringState = "gathering";
    const abort = new AbortController();
    const removePeerListener = vi.spyOn(pc, "removeEventListener");
    const starting = session.start(abort.signal);
    await vi.waitFor(() =>
      expect(pc.setLocalDescription).toHaveBeenCalledOnce(),
    );
    abort.abort();
    expect((await starting).isOk()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const event of [
      "icegatheringstatechange",
      "connectionstatechange",
      "signalingstatechange",
    ]) {
      expect(removePeerListener).toHaveBeenCalledWith(
        event,
        expect.any(Function),
      );
    }
    await session.dispose();
  });

  it("sends the offer once ICE gathering completes", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(answer())
        .mockResolvedValueOnce(new Response(null, { status: 204 })),
    );
    const { session, pc } = createSession();
    pc.iceGatheringState = "gathering";
    const abort = new AbortController();
    const removePeerListener = vi.spyOn(pc, "removeEventListener");
    const starting = session.start(abort.signal);
    await vi.waitFor(() =>
      expect(pc.setLocalDescription).toHaveBeenCalledOnce(),
    );
    pc.iceGatheringState = "complete";
    pc.dispatchEvent(new Event("icegatheringstatechange"));
    expect((await starting).isOk()).toBe(true);
    for (const event of [
      "icegatheringstatechange",
      "connectionstatechange",
      "signalingstatechange",
    ]) {
      expect(removePeerListener).toHaveBeenCalledWith(
        event,
        expect.any(Function),
      );
    }
    await session.dispose();
  });

  it.each(["signalingstatechange", "connectionstatechange"])(
    "stops waiting for ICE when the peer closes during %s",
    async (eventName) => {
      const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(answer());
      vi.stubGlobal("fetch", fetchSpy);
      const { session, pc } = createSession();
      pc.iceGatheringState = "gathering";
      const starting = session.start(new AbortController().signal);
      await vi.waitFor(() =>
        expect(pc.setLocalDescription).toHaveBeenCalledOnce(),
      );
      if (eventName === "signalingstatechange") pc.signalingState = "closed";
      else pc.connectionState = "closed";
      pc.dispatchEvent(new Event(eventName));
      expect((await starting).isOk()).toBe(true);
      expect(fetchSpy).toHaveBeenCalledOnce();
      await session.dispose({ notifyServer: false });
    },
  );

  it("returns an error if the browser does not retain its local offer", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    const { session, pc } = createSession();
    pc.setLocalDescription.mockImplementation(async () => undefined);
    const result = await session.start(new AbortController().signal);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe(
      "Failed to create local SDP offer",
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(pc.close).toHaveBeenCalledOnce();
  });

  it("does not post if the attempt aborts after setting its local offer", async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchSpy);
    const { session, pc } = createSession();
    const abort = new AbortController();
    pc.setLocalDescription.mockImplementation(async () => {
      abort.abort();
    });
    const result = await session.start(abort.signal);
    expect(result.isOk()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    await session.dispose({ notifyServer: false });
  });

  it("treats empty offers and failed transport as start errors", async () => {
    const noOffer = createSession();
    noOffer.pc.createOffer.mockResolvedValue({ type: "offer", sdp: "" });
    expect(
      (await noOffer.session.start(new AbortController().signal)).isErr(),
    ).toBe(true);

    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("offline")),
    );
    const failure = createSession();
    const result = await failure.session.start(new AbortController().signal);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected error");
    expect(result.error.message).toBe("offline");
  });

  it("rejects a failed WHEP counter-offer PATCH and deletes the session", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(answer("counter", 406))
      .mockResolvedValueOnce(new Response("bad answer", { status: 422 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { session } = createSession();
    const result = await session.start(new AbortController().signal);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected error");
    expect(result.error).toMatchObject({
      kind: "client_request_error",
      stage: "patch",
      message: "bad answer",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("rejects a counter-offer if no local SDP answer is produced", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(answer("counter", 406))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { session, pc } = createSession();
    pc.createAnswer.mockResolvedValue({ type: "answer", sdp: "" });
    const result = await session.start(new AbortController().signal);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toBe(
      "Failed to create local SDP answer",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      new URL("https://wish.test/play/user/session-1"),
      { method: "DELETE" },
    );
  });

  it("cleans up a counter-offer session when PATCH fails on the network", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(answer("counter", 406))
      .mockRejectedValueOnce(new TypeError("PATCH offline"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { session, pc } = createSession();
    const result = await session.start(new AbortController().signal);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      message: "PATCH offline",
    });
    expect(pc.close).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenNthCalledWith(
      3,
      new URL("https://wish.test/play/user/session-1"),
      { method: "DELETE" },
    );
  });

  it("allows repeated disposal and skips DELETE when requested", async () => {
    const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(answer());
    vi.stubGlobal("fetch", fetchSpy);
    const { session, pc } = createSession();
    expect((await session.start(new AbortController().signal)).isOk()).toBe(
      true,
    );
    await Promise.all([
      session.dispose({ notifyServer: false }),
      session.dispose(),
    ]);
    await session.dispose();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(pc.close).toHaveBeenCalledOnce();
  });

  it("keeps a stopped media track from reporting an active stream", async () => {
    const { session, pc, video, onStreamChange } = createSession();
    pc.connectionState = "connected";
    pc.iceConnectionState = "completed";
    pc.dispatchEvent(new Event("connectionstatechange"));
    const active = new FakeTrack("active");
    const muted = new FakeTrack("muted", "audio");
    muted.muted = true;
    const stream = video.srcObject;
    if (!(stream instanceof FakeMediaStream)) throw new Error("Missing stream");
    stream.addTrack(active);
    stream.addTrack(muted);
    expect(session.getSnapshot()).toMatchObject({
      hasStream: true,
      liveTrackCount: 2,
      mutedTrackCount: 1,
      remoteTrackCount: 2,
    });
    stream.removeTrack(active);
    expect(session.getSnapshot()).toMatchObject({
      hasStream: false,
      remoteTrackCount: 1,
      expectedRemoteTrackCount: 2,
    });
    expect(onStreamChange).toHaveBeenLastCalledWith(false);
    await session.dispose({ notifyServer: false });
  });

  it("ignores unrelated and malformed receiver stats", async () => {
    const { session, pc } = createSession();
    const missing = new FakeTrack("missing");
    const receiver = {
      track: missing,
      getStats: async () =>
        new Map<string, unknown>([
          ["null", null],
          ["primitive", 3],
          ["wrong", { type: "outbound-rtp", bytesReceived: 10 }],
          ["missing", { type: "inbound-rtp", bytesReceived: "ten" }],
        ]),
    };
    pc.receivers = [receiver];
    expect(await session.getInboundReceiverStats()).toEqual([]);
  });

  it("exposes structured error classification", () => {
    const notFound = new WHEPSessionError("missing", {
      kind: "resource_not_found",
      responseText: "missing",
      stage: "post",
    });
    expect(notFound).toMatchObject({
      name: "WHEPSessionError",
      retryable: true,
      responseText: "missing",
      stage: "post",
    });
    expect(notFound.isNotFound()).toBe(true);
    expect(notFound.isClientRequestError()).toBe(true);
    expect(
      new WHEPSessionError("client", {
        kind: "client_request_error",
        responseText: undefined,
        stage: "patch",
      }).isClientRequestError(),
    ).toBe(true);
    expect(
      new WHEPSessionError("server", {
        kind: "server_request_error",
        responseText: undefined,
        retryable: false,
        stage: "delete",
      }).isNotFound(),
    ).toBe(false);
  });

  it.each([
    ["new", "new", "stable", "connecting"],
    ["new", "connected", "stable", "connecting"],
    ["connecting", "connected", "stable", "connecting"],
    ["connecting", "checking", "stable", "connecting"],
    ["disconnected", "connected", "stable", "connecting"],
    ["connected", "checking", "stable", "connecting"],
    ["connected", "new", "stable", "connecting"],
    ["connected", "connected", "stable", "connected"],
    ["connected", "completed", "stable", "connected"],
    ["connected", "closed", "stable", "disconnected"],
    ["connected", "disconnected", "stable", "disconnected"],
    ["connected", "failed", "stable", "failed"],
    ["failed", "connected", "stable", "failed"],
    ["closed", "connected", "stable", "disconnected"],
    ["connected", "closed", "stable", "disconnected"],
    ["connected", "connected", "closed", "disconnected"],
  ] as const)(
    "derives connection status from peer=%s ice=%s signaling=%s",
    (connection, ice, signaling, expected) => {
      const { session, pc, onStatusChange } = createSession();
      pc.connectionState = connection;
      pc.iceConnectionState = ice;
      pc.signalingState = signaling;
      pc.dispatchEvent(new Event("connectionstatechange"));
      expect(session.getSnapshot().status).toBe(expected);
      if (expected === "disconnected") {
        expect(onStatusChange).not.toHaveBeenCalled();
      } else {
        expect(onStatusChange).toHaveBeenCalledExactlyOnceWith(expected);
      }
      pc.dispatchEvent(new Event("iceconnectionstatechange"));
      expect(onStatusChange).toHaveBeenCalledTimes(
        expected === "disconnected" ? 0 : 1,
      );
    },
  );

  it.each([
    ["disconnected", "connected", "stable", "connecting"],
    ["connected", "disconnected", "stable", "disconnected"],
    ["connected", "failed", "stable", "failed"],
    ["closed", "connected", "stable", "disconnected"],
    ["connected", "connected", "closed", "disconnected"],
  ] as const)(
    "clears the active stream when peer=%s ice=%s signaling=%s",
    async (connection, ice, signaling, expected) => {
      const { session, pc, video, onStatusChange, onStreamChange } =
        createSession();
      pc.connectionState = "connected";
      pc.iceConnectionState = "connected";
      pc.dispatchEvent(new Event("connectionstatechange"));
      const stream = video.srcObject;
      if (!(stream instanceof FakeMediaStream))
        throw new Error("Missing stream");
      stream.addTrack(new FakeTrack("video"));
      expect(session.getSnapshot().hasStream).toBe(true);
      pc.connectionState = connection;
      pc.iceConnectionState = ice;
      pc.signalingState = signaling;
      pc.dispatchEvent(new Event("iceconnectionstatechange"));
      expect(session.getSnapshot()).toMatchObject({
        hasStream: false,
        status: expected,
      });
      expect(onStatusChange).toHaveBeenLastCalledWith(expected);
      expect(onStreamChange).toHaveBeenLastCalledWith(false);
      await session.dispose({ notifyServer: false });
    },
  );

  it.each(["0", "-1", "not-a-number", "", "1.5"])(
    "rejects invalid live-track-count header %s",
    async (count) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(
            answer("remote", 201, { "Wish-Live-Track-Count": count }),
          ),
      );
      const { session } = createSession();
      const result = await session.start(new AbortController().signal);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toMatchObject({
        kind: "unexpected_response",
        responseText: count,
        retryable: false,
      });
    },
  );

  it("uses a relative session Location against the resource URL", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        answer("sdp", 201, { location: "./session-relative" }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { session } = createSession(" user / one ");
    expect((await session.start(new AbortController().signal)).isOk()).toBe(
      true,
    );
    await session.dispose();
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      new URL("https://wish.test/play/session-relative"),
      { method: "DELETE" },
    );
  });

  it("logs unsuccessful server session deletion with its response details", async () => {
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(answer())
      .mockResolvedValueOnce(new Response("expired", { status: 410 }));
    vi.stubGlobal("fetch", fetchSpy);
    const warning = vi.spyOn(console, "warn");
    const { session } = createSession();
    await session.start(new AbortController().signal);
    await session.dispose();
    expect(warning).toHaveBeenCalledWith(
      "Failed to close WHEP session:",
      expect.objectContaining({
        kind: "client_request_error",
        responseText: "expired",
        stage: "delete",
      }),
    );
  });

  it("ignores DELETE transport errors after local cleanup", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(answer())
        .mockRejectedValueOnce(new Error("connection lost")),
    );
    const warning = vi.spyOn(console, "warn");
    const { session, pc } = createSession();
    await session.start(new AbortController().signal);
    await expect(session.dispose()).resolves.toBeUndefined();
    expect(pc.close).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledWith(
      "Failed to close WHEP session:",
      expect.objectContaining({ message: "connection lost" }),
    );
  });

  it("uses track ID when MID is empty and excludes receivers without IDs", async () => {
    const { session, pc } = createSession();
    const track = new FakeTrack("fallback-id");
    const receiver = {
      track,
      getStats: async () =>
        new Map<string, unknown>([
          ["first", { type: "inbound-rtp", bytesReceived: 0 }],
          ["second", { type: "inbound-rtp", bytesReceived: 99 }],
        ]),
    };
    pc.receivers = [receiver];
    pc.transceivers = [{ receiver, mid: "" }];
    expect(await session.getInboundReceiverStats()).toEqual([
      { kind: "video", id: "fallback-id", bytesReceived: 0 },
    ]);
    track.id = "";
    expect(await session.getInboundReceiverStats()).toEqual([]);
  });

  it("reports ICE candidate errors and keeps listening for status changes", async () => {
    const { session, pc, onStatusChange } = createSession();
    const warning = vi.spyOn(console, "warn");
    const errorEvent = new Event("icecandidateerror");
    Object.assign(errorEvent, {
      errorCode: 701,
      errorText: "TURN unavailable",
      url: "turn:bad:3478",
    });
    pc.dispatchEvent(errorEvent);
    expect(warning).toHaveBeenCalledWith("ICE candidate error:", {
      errorCode: 701,
      errorText: "TURN unavailable",
      url: "turn:bad:3478",
    });
    expect(onStatusChange).toHaveBeenCalledExactlyOnceWith("connecting");
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    pc.dispatchEvent(new Event("icecandidate"));
    expect(session.getSnapshot().status).toBe("connected");
    expect(onStatusChange).toHaveBeenLastCalledWith("connected");
    await session.dispose({ notifyServer: false });
    pc.dispatchEvent(errorEvent);
    expect(warning).toHaveBeenCalledOnce();
  });

  it("restores the media stream on track events and handles autoplay rejection", async () => {
    const { session, pc, video } = createSession();
    const warning = vi.spyOn(console, "warn");
    video.play.mockRejectedValueOnce(new Error("autoplay denied"));
    video.srcObject = null;
    const track = new FakeTrack("incoming");
    const event = new Event("track");
    Object.defineProperty(event, "track", { value: track });
    pc.dispatchEvent(event);
    await vi.waitFor(() =>
      expect(warning).toHaveBeenCalledWith(
        "Autoplay failed:",
        expect.objectContaining({ message: "autoplay denied" }),
      ),
    );
    expect(video.srcObject).toBeInstanceOf(FakeMediaStream);
    expect(session.getSnapshot().remoteTrackCount).toBe(1);
    await session.dispose({ notifyServer: false });
    pc.dispatchEvent(event);
    expect(video.play).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("does not repeat stream callbacks for unchanged media availability", async () => {
    const { session, pc, video, onStreamChange, onStatusChange } =
      createSession();
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    pc.dispatchEvent(new Event("connectionstatechange"));
    const stream = video.srcObject;
    if (!(stream instanceof FakeMediaStream)) throw new Error("Missing stream");
    const track = new FakeTrack("a");
    stream.addTrack(track);
    expect(onStreamChange).toHaveBeenCalledExactlyOnceWith(true);
    stream.addTrack(new FakeTrack("b"));
    pc.dispatchEvent(new Event("negotiationneeded"));
    expect(onStreamChange).toHaveBeenCalledOnce();
    expect(onStatusChange).toHaveBeenCalledOnce();
    pc.iceConnectionState = "checking";
    pc.dispatchEvent(new Event("iceconnectionstatechange"));
    expect(session.getSnapshot()).toMatchObject({
      status: "connecting",
      hasStream: false,
    });
    expect(onStreamChange).toHaveBeenLastCalledWith(false);
    pc.iceConnectionState = "completed";
    pc.dispatchEvent(new Event("iceconnectionstatechange"));
    expect(session.getSnapshot().status).toBe("connected");
    expect(session.getSnapshot().hasStream).toBe(true);
    await session.dispose({ notifyServer: false });
  });

  it("removes a track and retains its historical maximum for expected media", async () => {
    const { session, pc, video } = createSession();
    pc.connectionState = "connected";
    pc.iceConnectionState = "connected";
    pc.dispatchEvent(new Event("connectionstatechange"));
    const stream = video.srcObject;
    if (!(stream instanceof FakeMediaStream)) throw new Error("Missing stream");
    const a = new FakeTrack("a");
    const b = new FakeTrack("b", "audio");
    stream.addTrack(a);
    stream.addTrack(b);
    expect(session.getSnapshot()).toMatchObject({
      remoteTrackCount: 2,
      expectedRemoteTrackCount: 2,
    });
    stream.removeTrack(a);
    expect(session.getSnapshot()).toMatchObject({
      remoteTrackCount: 1,
      liveTrackCount: 1,
      expectedRemoteTrackCount: 2,
    });
    a.muted = true;
    a.dispatchEvent(new Event("mute"));
    expect(session.getSnapshot().hasStream).toBe(true);
    await session.dispose({ notifyServer: false });
    expect(a.stop).not.toHaveBeenCalled();
    expect(b.stop).toHaveBeenCalledOnce();
  });

  it("deletes a server session that registers while disposal is waiting", async () => {
    let finishRegistration: ((response: Response) => void) | undefined;
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishRegistration = resolve;
          }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchSpy);
    const { session, pc } = createSession();
    const starting = session.start(new AbortController().signal);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    const disposing = session.dispose();
    expect(pc.close).toHaveBeenCalledOnce();
    finishRegistration?.(answer());
    expect((await starting).isOk()).toBe(true);
    await disposing;
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      new URL("https://wish.test/play/user/session-1"),
      { method: "DELETE" },
    );
    expect(session.getSnapshot().status).toBe("disconnected");
  });

  it("finishes local disposal when an in-flight registration fails", async () => {
    let rejectRegistration: ((error: Error) => void) | undefined;
    const fetchSpy = vi.fn<typeof fetch>().mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectRegistration = reject;
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const { session, pc } = createSession();
    const starting = session.start(new AbortController().signal);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledOnce());
    const disposing = session.dispose();
    rejectRegistration?.(new TypeError("registration aborted"));
    expect((await starting).isOk()).toBe(true);
    await disposing;
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(pc.close).toHaveBeenCalledOnce();
  });

  it("does not perform a second cleanup when dispose is called concurrently", async () => {
    let finishDeletion: ((response: Response) => void) | undefined;
    const fetchSpy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(answer())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishDeletion = resolve;
          }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const { session, pc } = createSession();
    await session.start(new AbortController().signal);
    const first = session.dispose();
    const second = session.dispose();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    finishDeletion?.(new Response(null, { status: 204 }));
    await Promise.all([first, second]);
    await session.dispose();
    expect(pc.close).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    [404, "resource_not_found"],
    [499, "client_request_error"],
    [500, "server_request_error"],
    [599, "server_request_error"],
    [302, "unexpected_response"],
  ] as const)(
    "classifies HTTP %i and preserves a nonempty response",
    async (status, kind) => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response("  reason  ", { status })),
      );
      const { session } = createSession();
      const result = await session.start(new AbortController().signal);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toMatchObject({
        kind,
        message: "  reason  ",
        responseText: "  reason  ",
        stage: "post",
      });
    },
  );

  it("uses the fallback message when the response body is whitespace", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("  \n ", { status: 502 })),
    );
    const { session } = createSession();
    const result = await session.start(new AbortController().signal);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "server_request_error",
      message: "Unexpected WHEP session response: 502",
      responseText: undefined,
    });
  });

  it("uses the fallback message if an error response cannot be read", async () => {
    const response = new Response("unreadable", { status: 503 });
    vi.spyOn(response, "text").mockRejectedValue(
      new Error("body stream failed"),
    );
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(response));
    const { session } = createSession();
    const result = await session.start(new AbortController().signal);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "server_request_error",
      message: "Unexpected WHEP session response: 503",
      responseText: undefined,
    });
  });

  it("accepts an SDP content type with different casing and parameters", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        answer("remote", 201, {
          "content-type": "APPLICATION/SDP; charset=utf-8",
        }),
      ),
    );
    const { session, pc } = createSession();
    expect((await session.start(new AbortController().signal)).isOk()).toBe(
      true,
    );
    expect(pc.remoteDescription).toEqual({ type: "answer", sdp: "remote" });
    await session.dispose({ notifyServer: false });
  });

  it.each(["closed signaling", "closed connection"])(
    "finishes ICE gathering when the peer has %s",
    async (state) => {
      const fetchSpy = vi.fn<typeof fetch>().mockResolvedValue(answer());
      vi.stubGlobal("fetch", fetchSpy);
      const { session, pc } = createSession();
      pc.iceGatheringState = "gathering";
      if (state === "closed signaling") pc.signalingState = "closed";
      else pc.connectionState = "closed";
      expect((await session.start(new AbortController().signal)).isOk()).toBe(
        true,
      );
      expect(fetchSpy).toHaveBeenCalledOnce();
      await session.dispose({ notifyServer: false });
    },
  );
});
