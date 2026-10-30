import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type WHEPConnectionStatus,
  WHEPSession,
  WHEPSessionError,
} from "./WHEPClient";

const turnMocks = vi.hoisted(() => ({
  fetchTurnIceServers:
    vi.fn<(signal: AbortSignal) => Promise<RTCIceServer[] | null>>(),
}));
vi.mock("./turn-credentials", () => turnMocks);

const ORIGIN = "http://localhost";
const SESSION_URL = `${ORIGIN}/play/alice/session-1`;

class FakeTrack extends EventTarget {
  muted = false;
  readyState: MediaStreamTrackState = "live";
  readonly stop = vi.fn<() => void>(() => {
    this.readyState = "ended";
  });

  readonly id: string;
  readonly kind: "audio" | "video";

  constructor(kind: "audio" | "video") {
    super();
    this.id = `${kind}-track`;
    this.kind = kind;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.dispatchEvent(new Event(muted ? "mute" : "unmute"));
  }

  end(): void {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeMediaStream extends EventTarget {
  private readonly tracks: FakeTrack[] = [];

  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }

  // Like the browser API, addTrack() itself does not dispatch "addtrack".
  addTrack(track: FakeTrack): void {
    if (!this.tracks.includes(track)) {
      this.tracks.push(track);
    }
  }
}

type FakeReceiver = {
  getStats: () => Promise<{
    forEach: (callback: (report: unknown) => void) => void;
  }>;
  track: Pick<FakeTrack, "id" | "kind">;
};

type ConnectionStates = Partial<{
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
  iceGatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
}>;

class FakePeerConnection extends EventTarget {
  static instances: FakePeerConnection[] = [];

  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  configuration: RTCConfiguration;
  receivers: FakeReceiver[] = [];
  transceivers: { mid: string | null; receiver: FakeReceiver }[] = [];

  readonly addTransceiver =
    vi.fn<(kind: string, init: RTCRtpTransceiverInit) => void>();
  readonly createOffer = vi.fn<() => Promise<RTCSessionDescriptionInit>>(
    async () => ({ sdp: "local-offer", type: "offer" }),
  );
  readonly createAnswer = vi.fn<() => Promise<RTCSessionDescriptionInit>>(
    async () => ({ sdp: "local-answer", type: "answer" }),
  );
  readonly setLocalDescription = vi.fn<
    (description: RTCSessionDescriptionInit) => Promise<void>
  >(async (description) => {
    this.localDescription =
      description.type === "rollback" ? null : description;
  });
  readonly setRemoteDescription =
    vi.fn<(description: RTCSessionDescriptionInit) => Promise<void>>();
  readonly close = vi.fn<() => void>(() => {
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
    this.signalingState = "closed";
  });

  constructor(configuration: RTCConfiguration) {
    super();
    this.configuration = { ...configuration };
    FakePeerConnection.instances.push(this);
  }

  getConfiguration(): RTCConfiguration {
    return this.configuration;
  }

  setConfiguration(configuration: RTCConfiguration): void {
    this.configuration = configuration;
  }

  getReceivers(): FakeReceiver[] {
    return this.receivers;
  }

  getTransceivers(): { mid: string | null; receiver: FakeReceiver }[] {
    return this.transceivers;
  }

  updateStates(states: ConnectionStates, eventType: string): void {
    Object.assign(this, states);
    this.dispatchEvent(new Event(eventType));
  }

  connect(): void {
    this.updateStates(
      { connectionState: "connected", iceConnectionState: "connected" },
      "iceconnectionstatechange",
    );
  }

  emitTrack(track: FakeTrack): void {
    const event = new Event("track");
    Object.defineProperty(event, "track", { value: track });
    this.dispatchEvent(event);
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

function sdpResponse(
  status: number,
  headers: Record<string, string> = {},
  body = "remote-sdp",
): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/sdp",
      Location: "/play/alice/session-1",
      ...headers,
    },
    status,
  });
}

function createVideoElement(
  play: () => Promise<void> = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined),
) {
  const videoElement: Pick<HTMLVideoElement, "srcObject" | "play"> = {
    play,
    srcObject: null,
  };
  return videoElement;
}

function createSession({
  play,
  resourceUserId = "alice",
}: {
  play?: () => Promise<void>;
  resourceUserId?: string;
} = {}) {
  const statuses: WHEPConnectionStatus[] = [];
  const streams: boolean[] = [];
  const videoElement = createVideoElement(play);
  const session = new WHEPSession({
    callbacks: {
      onStatusChange: (status) => {
        statuses.push(status);
      },
      onStreamChange: (hasStream) => {
        streams.push(hasStream);
      },
    },
    resourceUserId,
    videoElement,
  });
  const pc = FakePeerConnection.instances.at(-1);
  if (pc === undefined) {
    throw new Error("Expected the session to create a peer connection");
  }
  return { pc, session, statuses, streams, videoElement };
}

function statsReceiver(
  track: Pick<FakeTrack, "id" | "kind">,
  reports: unknown[],
): FakeReceiver {
  return {
    getStats: async () => ({
      forEach: (callback) => {
        for (const report of reports) {
          callback(report);
        }
      },
    }),
    track,
  };
}

function fetchCalls(fetchSpy: ReturnType<typeof mockFetch>) {
  return fetchSpy.mock.calls.map(([input, init]) => ({
    method: init?.method,
    url: input instanceof Request ? input.url : String(input),
  }));
}

function mockFetch() {
  return vi.spyOn(globalThis, "fetch");
}

describe("WHEPSession", () => {
  beforeEach(() => {
    FakePeerConnection.instances.length = 0;
    vi.stubGlobal("window", { location: { origin: ORIGIN } });
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
    vi.stubGlobal("MediaStream", FakeMediaStream);
    vi.stubGlobal("RTCSessionDescription", FakeSessionDescription);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    turnMocks.fetchTurnIceServers.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("prepares a receive-only peer connection and attaches its stream", () => {
    expect(
      () =>
        new WHEPSession({
          resourceUserId: "  ",
          videoElement: createVideoElement(),
        }),
    ).toThrow("Resource user id is required");

    const { pc, session, videoElement } = createSession();

    expect(pc.getConfiguration()).toEqual({ bundlePolicy: "max-bundle" });
    expect(pc.addTransceiver.mock.calls).toEqual([
      ["video", { direction: "recvonly" }],
      ["audio", { direction: "recvonly" }],
    ]);
    expect(videoElement.srcObject).toBeInstanceOf(FakeMediaStream);
    expect(session.getSnapshot()).toMatchObject({
      hasStream: false,
      status: "disconnected",
    });
  });

  it("posts a complete offer and applies the WHEP answer", async () => {
    turnMocks.fetchTurnIceServers.mockResolvedValue([
      { urls: ["turn:turn.example.com:3478"] },
    ]);
    const fetchSpy = mockFetch().mockResolvedValue(
      sdpResponse(201, { "Wish-Live-Track-Count": "2" }, "remote-answer"),
    );
    const { pc, session, statuses } = createSession({
      resourceUserId: "alice/id",
    });

    const result = await session.start(new AbortController().signal);

    expect(result.isOk()).toBe(true);
    expect(statuses).toEqual(["connecting"]);
    expect(pc.getConfiguration().iceServers).toEqual([
      { urls: ["turn:turn.example.com:3478"] },
    ]);
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchCalls(fetchSpy)).toEqual([
      { method: "POST", url: `${ORIGIN}/play/alice%2Fid` },
    ]);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      body: "local-offer",
      headers: {
        Accept: "application/sdp",
        "Content-Type": "application/sdp",
      },
      method: "POST",
    });
    expect(pc.setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({ sdp: "remote-answer", type: "answer" }),
    );
    expect(session.getSnapshot().expectedRemoteTrackCount).toBe(2);
  });

  it("keeps the default ICE configuration when TURN credentials are unavailable", async () => {
    mockFetch().mockResolvedValue(sdpResponse(201));
    const { pc, session } = createSession();

    await session.start(new AbortController().signal);

    expect(pc.getConfiguration()).toEqual({ bundlePolicy: "max-bundle" });
  });

  it("waits for ICE gathering to complete before posting the offer", async () => {
    const fetchSpy = mockFetch().mockResolvedValue(sdpResponse(201));
    const { pc, session } = createSession();
    pc.iceGatheringState = "gathering";

    const pending = session.start(new AbortController().signal);
    await vi.waitFor(() => {
      expect(pc.setLocalDescription).toHaveBeenCalled();
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    pc.updateStates(
      { iceGatheringState: "complete" },
      "icegatheringstatechange",
    );

    expect((await pending).isOk()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("answers a 406 counter-offer with a PATCH to the session URL", async () => {
    const fetchSpy = mockFetch()
      .mockResolvedValueOnce(sdpResponse(406, {}, "remote-offer"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const { pc, session } = createSession();

    const result = await session.start(new AbortController().signal);

    expect(result.isOk()).toBe(true);
    expect(pc.setLocalDescription.mock.calls.map(([d]) => d.type)).toEqual([
      "offer",
      "rollback",
      "answer",
    ]);
    expect(pc.setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({ sdp: "remote-offer", type: "offer" }),
    );
    expect(fetchCalls(fetchSpy)).toEqual([
      { method: "POST", url: `${ORIGIN}/play/alice` },
      { method: "PATCH", url: SESSION_URL },
    ]);
    expect(fetchSpy.mock.calls[1]?.[1]?.body).toBe("local-answer");
  });

  it.each([
    [404, "resource_not_found"],
    [403, "client_request_error"],
    [503, "server_request_error"],
    [200, "unexpected_response"],
  ] as const)(
    "fails with %i offer responses as %s without a session to delete",
    async (status, kind) => {
      const fetchSpy = mockFetch().mockResolvedValue(
        new Response("offer rejected", { status }),
      );
      const { pc, session, statuses } = createSession();

      const error = (
        await session.start(new AbortController().signal)
      )._unsafeUnwrapErr();

      expect(error).toBeInstanceOf(WHEPSessionError);
      expect(error).toMatchObject({
        kind,
        message: "offer rejected",
        stage: "post",
      });
      expect(statuses).toEqual(["connecting", "disconnected", "failed"]);
      expect(pc.close).toHaveBeenCalledOnce();
      expect(fetchCalls(fetchSpy)).toEqual([
        { method: "POST", url: `${ORIGIN}/play/alice` },
      ]);
    },
  );

  it.each([
    [
      "a missing Location header",
      new Response("remote-sdp", {
        headers: { "Content-Type": "application/sdp" },
        status: 201,
      }),
      "missing_session_location",
    ],
    [
      "an invalid track count",
      sdpResponse(201, { "Wish-Live-Track-Count": "0" }),
      "unexpected_response",
    ],
    [
      "a non-SDP content type",
      sdpResponse(201, { "Content-Type": "text/plain" }),
      "invalid_sdp_response",
    ],
    ["an empty SDP body", sdpResponse(201, {}, "  "), "invalid_sdp_response"],
  ] as const)(
    "rejects an offer response with %s without retrying",
    async (_name, response, kind) => {
      mockFetch().mockResolvedValue(response);
      const { session } = createSession();

      const error = (
        await session.start(new AbortController().signal)
      )._unsafeUnwrapErr();

      expect(error).toMatchObject({ kind, retryable: false });
      expect(session.getSnapshot().status).toBe("failed");
    },
  );

  it("deletes the registered session when the WHEP answer cannot be applied", async () => {
    const fetchSpy = mockFetch()
      .mockResolvedValueOnce(sdpResponse(201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { pc, session } = createSession();
    pc.setRemoteDescription.mockRejectedValue(new Error("bad answer"));

    const result = await session.start(new AbortController().signal);

    expect(result._unsafeUnwrapErr()).toMatchObject({ message: "bad answer" });
    expect(session.getSnapshot().status).toBe("failed");
    expect(fetchCalls(fetchSpy)).toEqual([
      { method: "POST", url: `${ORIGIN}/play/alice` },
      { method: "DELETE", url: SESSION_URL },
    ]);
  });

  it("deletes the registered session when the counter-offer answer is rejected", async () => {
    const fetchSpy = mockFetch()
      .mockResolvedValueOnce(sdpResponse(406))
      .mockResolvedValueOnce(new Response("bad answer", { status: 400 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { session } = createSession();

    const result = await session.start(new AbortController().signal);

    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "client_request_error",
      stage: "patch",
    });
    expect(fetchCalls(fetchSpy)).toEqual([
      { method: "POST", url: `${ORIGIN}/play/alice` },
      { method: "PATCH", url: SESSION_URL },
      { method: "DELETE", url: SESSION_URL },
    ]);
  });

  it("stops quietly when the attempt is aborted during ICE gathering", async () => {
    const fetchSpy = mockFetch();
    const { pc, session, statuses } = createSession();
    pc.iceGatheringState = "gathering";
    const attempt = new AbortController();

    const pending = session.start(attempt.signal);
    await vi.waitFor(() => {
      expect(pc.setLocalDescription).toHaveBeenCalled();
    });
    attempt.abort();

    expect((await pending).isOk()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(statuses).toEqual(["connecting"]);
  });

  it("tracks stream availability from the connection and remote tracks", () => {
    const { pc, session, statuses, streams, videoElement } = createSession();
    const track = new FakeTrack("video");

    pc.connect();
    pc.emitTrack(track);
    expect(statuses).toEqual(["connected"]);
    expect(streams).toEqual([true]);
    expect(videoElement.play).toHaveBeenCalledOnce();

    track.setMuted(true);
    track.setMuted(false);
    track.end();
    expect(streams).toEqual([true, false, true, false]);

    expect(session.getSnapshot()).toMatchObject({
      liveTrackCount: 0,
      remoteTrackCount: 1,
    });
  });

  it("drops the stream when the connection leaves the connected state", () => {
    const { pc, streams } = createSession();
    pc.connect();
    pc.emitTrack(new FakeTrack("video"));

    pc.updateStates(
      { iceConnectionState: "disconnected" },
      "iceconnectionstatechange",
    );

    expect(streams).toEqual([true, false]);
  });

  it.each([
    [{ iceConnectionState: "checking" }, "connecting"],
    [
      { connectionState: "connected", iceConnectionState: "checking" },
      "connecting",
    ],
    [
      { connectionState: "connected", iceConnectionState: "completed" },
      "connected",
    ],
    [{ connectionState: "connected", iceConnectionState: "failed" }, "failed"],
    [{ connectionState: "failed", iceConnectionState: "connected" }, "failed"],
    [
      {
        connectionState: "connected",
        iceConnectionState: "connected",
        signalingState: "closed",
      },
      "disconnected",
    ],
  ] as const)("derives the session status from %j", (states, status) => {
    const { pc, session } = createSession();

    pc.updateStates(states, "connectionstatechange");

    expect(session.getSnapshot().status).toBe(status);
  });

  it("warns without dropping the stream when autoplay is rejected", async () => {
    const { pc, streams } = createSession({
      play: vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new Error("autoplay blocked")),
    });

    pc.connect();
    pc.emitTrack(new FakeTrack("video"));

    await vi.waitFor(() => {
      expect(console.warn).toHaveBeenCalledWith(
        "Autoplay failed:",
        expect.any(Error),
      );
    });
    expect(streams).toEqual([true]);
  });

  it("releases local media and deletes the server session once on dispose", async () => {
    const fetchSpy = mockFetch()
      .mockResolvedValueOnce(sdpResponse(201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { pc, session, statuses, videoElement } = createSession();
    await session.start(new AbortController().signal);
    const track = new FakeTrack("video");
    pc.connect();
    pc.emitTrack(track);

    await Promise.all([session.dispose(), session.dispose()]);

    expect(pc.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(videoElement.srcObject).toBeNull();
    expect(statuses.at(-1)).toBe("disconnected");
    expect(fetchCalls(fetchSpy)).toEqual([
      { method: "POST", url: `${ORIGIN}/play/alice` },
      { method: "DELETE", url: SESSION_URL },
    ]);
  });

  it("skips the server DELETE when asked not to notify the server", async () => {
    const fetchSpy = mockFetch().mockResolvedValueOnce(sdpResponse(201));
    const { session } = createSession();
    await session.start(new AbortController().signal);

    await session.dispose({ notifyServer: false });

    expect(fetchCalls(fetchSpy)).toEqual([
      { method: "POST", url: `${ORIGIN}/play/alice` },
    ]);
  });

  it("waits for an in-flight offer so its session can still be deleted", async () => {
    const fetchSpy = mockFetch()
      // The Worker has already created the Calls session when the abort lands,
      // so the offer response still arrives.
      .mockImplementationOnce(
        (_input, init) =>
          new Promise((resolve) => {
            init?.signal?.addEventListener("abort", () => {
              resolve(sdpResponse(201));
            });
          }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const { session } = createSession();
    const pending = session.start(new AbortController().signal);
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    await session.dispose();

    expect((await pending).isOk()).toBe(true);
    expect(fetchCalls(fetchSpy)).toEqual([
      { method: "POST", url: `${ORIGIN}/play/alice` },
      { method: "DELETE", url: SESSION_URL },
    ]);
  });

  it("finishes dispose with a warning when the server DELETE fails", async () => {
    mockFetch()
      .mockResolvedValueOnce(sdpResponse(201))
      .mockRejectedValueOnce(new TypeError("offline"));
    const { session } = createSession();
    await session.start(new AbortController().signal);

    await expect(session.dispose()).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledWith(
      "Failed to close WHEP session:",
      expect.any(TypeError),
    );
  });

  it("ignores start and connection events after dispose", async () => {
    const fetchSpy = mockFetch();
    const { pc, session, statuses } = createSession();
    await session.dispose({ notifyServer: false });

    const result = await session.start(new AbortController().signal);
    pc.connect();

    expect(result.isOk()).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(statuses).toEqual([]);
  });

  it("reports inbound bytes per receiver keyed by MID or track id", async () => {
    const { pc, session } = createSession();
    const video = statsReceiver({ id: "video-track", kind: "video" }, [
      { bytesReceived: 5, type: "outbound-rtp" },
      { bytesReceived: 10, type: "inbound-rtp" },
      { bytesReceived: 20, type: "inbound-rtp" },
    ]);
    const audio = statsReceiver({ id: "audio-track", kind: "audio" }, [
      { bytesReceived: 3, type: "inbound-rtp" },
    ]);
    const silent = statsReceiver({ id: "silent-track", kind: "audio" }, []);
    pc.receivers = [video, audio, silent];
    pc.transceivers = [
      { mid: "0", receiver: video },
      { mid: null, receiver: audio },
    ];

    await expect(session.getInboundReceiverStats()).resolves.toEqual([
      { bytesReceived: 10, id: "0", kind: "video" },
      { bytesReceived: 3, id: "audio-track", kind: "audio" },
    ]);
  });
});
