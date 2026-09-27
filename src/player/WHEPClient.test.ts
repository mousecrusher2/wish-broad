// @vitest-environment jsdom
// oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion, typescript/no-unsafe-assignment, typescript/no-unsafe-return, typescript/no-unnecessary-condition, typescript/strict-void-return, vitest/require-mock-type-parameters, vitest/no-conditional-expect -- WebRTC fakes model partial browser interfaces, and Result guards narrow errors before assertions.
import * as fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const turnMocks = vi.hoisted(() => ({
  fetchTurnIceServers: vi.fn(),
}));
vi.mock("./turn-credentials", () => turnMocks);

import { WHEPSession, WHEPSessionError } from "./WHEPClient";

type FakeTrack = EventTarget & {
  id: string;
  kind: string;
  muted: boolean;
  readyState: string;
  stop: () => void;
};

type FakeReceiver = {
  track: Pick<FakeTrack, "id" | "kind">;
  getStats: () => Promise<{
    forEach: (callback: (report: unknown) => void) => void;
  }>;
};

class MockTrack extends EventTarget {
  id = "track-1";
  kind = "video";
  muted = false;
  readyState = "live";
  stop = vi.fn(() => {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  });
}

class MockMediaStream extends EventTarget {
  static instances: MockMediaStream[] = [];
  private readonly tracks: FakeTrack[] = [];

  constructor() {
    super();
    MockMediaStream.instances.push(this);
  }

  getTracks(): FakeTrack[] {
    return [...this.tracks];
  }

  addTrack(track: FakeTrack): void {
    if (this.tracks.includes(track)) return;
    this.tracks.push(track);
    this.dispatchTrackEvent("addtrack", track);
  }

  removeTrack(track: FakeTrack): void {
    this.tracks.splice(this.tracks.indexOf(track), 1);
    this.dispatchTrackEvent("removetrack", track);
  }

  private dispatchTrackEvent(type: string, track: FakeTrack): void {
    const event = new Event(type);
    Object.defineProperty(event, "track", { value: track });
    this.dispatchEvent(event);
  }
}

class MockRTCPeerConnection extends EventTarget {
  static instances: MockRTCPeerConnection[] = [];
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "complete";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescriptionInit | null = null;
  readonly config = { iceServers: [] as RTCIceServer[] };
  readonly receivers: FakeReceiver[] = [];
  readonly transceivers: Array<{ mid: string | null; receiver: FakeReceiver }> =
    [];
  readonly addTransceiver = vi.fn((kind: string) => {
    const track = { id: `${kind}-track`, kind } as Pick<
      FakeTrack,
      "id" | "kind"
    >;
    const receiver: FakeReceiver = {
      track,
      getStats: async () => ({ forEach: () => undefined }),
    };
    const transceiver = { mid: String(this.transceivers.length), receiver };
    this.transceivers.push(transceiver);
    this.receivers.push(receiver);
    return transceiver;
  });
  readonly createOffer = vi.fn(async () => ({
    type: "offer",
    sdp: "local-offer",
  }));
  readonly createAnswer = vi.fn(async () => ({
    type: "answer",
    sdp: "local-answer",
  }));
  readonly setLocalDescription = vi.fn(
    async (description?: RTCSessionDescriptionInit) => {
      this.localDescription =
        description?.type === "rollback"
          ? null
          : {
              type: description?.type ?? "offer",
              sdp: description?.sdp ?? "local-offer",
            };
      if (description?.type === "rollback") this.signalingState = "stable";
    },
  );
  readonly setRemoteDescription = vi.fn(
    async (_description: RTCSessionDescriptionInit) => undefined,
  );
  readonly setConfiguration = vi.fn((configuration: RTCConfiguration) => {
    Object.assign(this.config, configuration);
  });
  readonly getConfiguration = vi.fn(() => this.config);
  readonly getReceivers = vi.fn(() => this.receivers);
  readonly getTransceivers = vi.fn(() => this.transceivers);
  readonly close = vi.fn(() => {
    this.connectionState = "closed";
    this.iceConnectionState = "closed";
    this.signalingState = "closed";
  });

  constructor(configuration?: RTCConfiguration) {
    super();
    Object.assign(this.config, configuration);
    MockRTCPeerConnection.instances.push(this);
  }

  emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }

  emitTrack(track: FakeTrack): void {
    const event = new Event("track");
    Object.defineProperty(event, "track", { value: track });
    this.dispatchEvent(event);
  }
}

class MockRTCSessionDescription {
  readonly type: RTCSdpType;
  readonly sdp: string;

  constructor(description: RTCSessionDescriptionInit) {
    this.type = description.type;
    this.sdp = description.sdp ?? "";
  }
}

function videoElement(): HTMLVideoElement {
  const video = document.createElement("video");
  Object.defineProperty(video, "play", {
    configurable: true,
    value: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  });
  return video;
}

function sdpResponse(
  status = 201,
  headers?: Record<string, string>,
  body = "remote-sdp",
): Response {
  const response = new Response(body, {
    headers: headers ?? {
      "content-type": "application/sdp; charset=utf-8",
      location: "/play/alice/session-1",
    },
    status,
  });
  if (headers && headers["content-type"] === undefined) {
    response.headers.delete("content-type");
  }
  return response;
}

function createSession(
  callbacks: ConstructorParameters<typeof WHEPSession>[0]["callbacks"] = {},
) {
  return new WHEPSession({
    callbacks,
    resourceUserId: " alice ",
    videoElement: videoElement(),
  });
}

function peerConnection(): MockRTCPeerConnection {
  const connection = MockRTCPeerConnection.instances.at(-1);
  if (!connection) throw new Error("Expected a mocked peer connection");
  return connection;
}

describe("WHEP WebRTC session", () => {
  beforeEach(() => {
    MockMediaStream.instances.length = 0;
    MockRTCPeerConnection.instances.length = 0;
    vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection);
    vi.stubGlobal("MediaStream", MockMediaStream);
    vi.stubGlobal("RTCSessionDescription", MockRTCSessionDescription);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    turnMocks.fetchTurnIceServers.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("validates the resource id and prepares receive-only media", () => {
    expect(
      () =>
        new WHEPSession({ resourceUserId: "  ", videoElement: videoElement() }),
    ).toThrow("Resource user id is required");

    const video = videoElement();
    const session = new WHEPSession({
      resourceUserId: " alice ",
      videoElement: video,
    });

    expect(peerConnection().getConfiguration()).toEqual({
      bundlePolicy: "max-bundle",
      iceServers: [],
    });
    expect(video.srcObject).toBeInstanceOf(MockMediaStream);
    expect(peerConnection().addTransceiver.mock.calls).toEqual([
      ["video", { direction: "recvonly" }],
      ["audio", { direction: "recvonly" }],
    ]);
    expect(session.getSnapshot()).toMatchObject({
      status: "disconnected",
      remoteTrackCount: 0,
    });
    void session.dispose({ notifyServer: false });
  });

  it("creates an offer, applies TURN configuration, and accepts a WHEP answer", async () => {
    const video = videoElement();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onStatusChange = vi.fn();
    const session = new WHEPSession({
      callbacks: { onStatusChange },
      resourceUserId: "alice/id",
      videoElement: video,
    });
    const iceServers = [
      { urls: "turn:relay.example", username: "user", credential: "pass" },
    ];
    turnMocks.fetchTurnIceServers.mockResolvedValue(iceServers);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sdpResponse(201, {
        "content-type": "Application/SDP; charset=utf-8",
        location: "/play/alice/session-1",
        "Wish-Live-Track-Count": "2",
      }),
    );

    const result = await session.start(new AbortController().signal);

    expect(result.isOk()).toBe(true);
    expect(onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      "connecting",
    ]);
    expect(turnMocks.fetchTurnIceServers).toHaveBeenCalledWith(
      expect.any(AbortSignal),
    );
    expect(peerConnection().setConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ iceServers }),
    );
    expect(fetch).toHaveBeenCalledWith(
      new URL("/play/alice%2Fid", window.location.origin),
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/sdp",
          "Content-Type": "application/sdp",
        },
        body: "local-offer",
      }),
    );
    expect(peerConnection().setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({ type: "answer", sdp: "remote-sdp" }),
    );
    expect(session.getSnapshot().expectedRemoteTrackCount).toBe(2);

    await session.dispose();
    expect(fetch).toHaveBeenLastCalledWith(
      new URL("/play/alice/session-1", window.location.origin),
      { method: "DELETE" },
    );
    expect(video.srcObject).toBeNull();
    expect(peerConnection().close).toHaveBeenCalledOnce();
    expect(warn).not.toHaveBeenCalled();
  });

  it("accepts a declared single remote track", async () => {
    const session = createSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sdpResponse(201, {
        "content-type": "application/sdp",
        location: "/play/alice/session-1",
        "Wish-Live-Track-Count": "1",
      }),
    );

    const result = await session.start(new AbortController().signal);

    expect(result.isOk()).toBe(true);
    expect(session.getSnapshot().expectedRemoteTrackCount).toBe(1);
    await session.dispose({ notifyServer: false });
  });

  it("releases local resources without deleting a registered server session", async () => {
    const video = videoElement();
    const session = new WHEPSession({
      resourceUserId: "alice",
      videoElement: video,
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sdpResponse());

    expect((await session.start(new AbortController().signal)).isOk()).toBe(
      true,
    );
    await session.dispose({ notifyServer: false });

    expect(fetch).toHaveBeenCalledOnce();
    expect(peerConnection().close).toHaveBeenCalledOnce();
    expect(video.srcObject).toBeNull();
    expect(session.getSnapshot().status).toBe("disconnected");
  });

  it("leaves the expected track count unspecified when the header is absent", async () => {
    const session = createSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sdpResponse(201, {
        "content-type": "application/sdp",
        location: "/play/alice/session-1",
      }),
    );

    const result = await session.start(new AbortController().signal);

    expect(result.isOk()).toBe(true);
    expect(session.getSnapshot().expectedRemoteTrackCount).toBe(0);
    await session.dispose({ notifyServer: false });
  });

  it("does not replace ICE configuration when TURN discovery is unavailable", async () => {
    const session = createSession();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sdpResponse());

    await session.start(new AbortController().signal);

    expect(peerConnection().setConfiguration).not.toHaveBeenCalled();
    await session.dispose({ notifyServer: false });
  });

  it("rejects an offer when the browser does not produce local SDP", async () => {
    const session = createSession();
    const connection = peerConnection();
    connection.setLocalDescription.mockImplementation(async () => {
      connection.localDescription = null;
    });
    const fetch = vi.spyOn(globalThis, "fetch");

    const result = await session.start(new AbortController().signal);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("Failed to create local SDP offer");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a no-op result for an already-aborted or disposed session", async () => {
    const session = createSession();
    const controller = new AbortController();
    controller.abort();
    expect((await session.start(controller.signal)).isOk()).toBe(true);
    expect(turnMocks.fetchTurnIceServers).not.toHaveBeenCalled();

    await session.dispose({ notifyServer: false });
    expect((await session.start(new AbortController().signal)).isOk()).toBe(
      true,
    );
  });

  it.each([
    [404, "resource_not_found"],
    [400, "client_request_error"],
    [399, "unexpected_response"],
    [499, "client_request_error"],
    [500, "server_request_error"],
    [302, "unexpected_response"],
  ] as const)(
    "classifies a failed WHEP POST status %i",
    async (status, kind) => {
      const session = createSession();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(" response body ", { status }),
      );

      const result = await session.start(new AbortController().signal);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toBeInstanceOf(WHEPSessionError);
        const sessionError = result.error as WHEPSessionError;
        expect(result.error).toMatchObject({
          kind,
          responseText: " response body ",
          stage: "post",
          retryable: true,
        });
        expect(sessionError.name).toBe("WHEPSessionError");
        expect(sessionError.message).toBe(" response body ");
        expect(sessionError.isNotFound()).toBe(kind === "resource_not_found");
        expect(sessionError.isClientRequestError()).toBe(
          kind === "resource_not_found" || kind === "client_request_error",
        );
      }
      expect(peerConnection().close).toHaveBeenCalledOnce();
    },
  );

  it.each(["", "   ", "read-error"])(
    "uses a fallback error message when a failure body is blank or unreadable (%s)",
    async (body) => {
      const session = createSession();
      const response = new Response(body === "read-error" ? "body" : body, {
        status: 502,
      });
      if (body === "read-error") {
        vi.spyOn(response, "text").mockRejectedValue(new Error("read failed"));
      }
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

      const result = await session.start(new AbortController().signal);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({
          message: "Unexpected WHEP session response: 502",
          responseText: undefined,
          retryable: true,
          stage: "post",
        });
      }
    },
  );

  it.each([
    [
      { "content-type": "text/plain", location: "/session" },
      "remote-sdp",
      "invalid_sdp_response",
      "Unexpected WHEP SDP response content type",
    ],
    [
      { location: "/session" },
      "remote-sdp",
      "invalid_sdp_response",
      "Unexpected WHEP SDP response content type",
    ],
    [
      { "content-type": "application/sdp", location: "/session" },
      "   ",
      "invalid_sdp_response",
      "Empty SDP response",
    ],
    [
      { "content-type": "application/sdp" },
      "remote-sdp",
      "missing_session_location",
      "Missing WHEP session location header",
    ],
    [
      {
        "content-type": "application/sdp",
        location: "/session",
        "Wish-Live-Track-Count": "0",
      },
      "remote-sdp",
      "unexpected_response",
      "Invalid Wish-Live-Track-Count header",
    ],
    [
      {
        "content-type": "application/sdp",
        location: "/session",
        "Wish-Live-Track-Count": "many",
      },
      "remote-sdp",
      "unexpected_response",
      "Invalid Wish-Live-Track-Count header",
    ],
  ] as const)(
    "rejects malformed WHEP session responses",
    async (headers, body, kind, message) => {
      const session = createSession();
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        sdpResponse(201, headers, body),
      );

      const result = await session.start(new AbortController().signal);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({
          kind,
          message,
          retryable: false,
          stage: "post",
        });
      }
    },
  );

  it("answers a 406 counter-offer with rollback, a local answer, and PATCH", async () => {
    const session = createSession();
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch
      .mockResolvedValueOnce(
        sdpResponse(
          406,
          {
            "content-type": "application/sdp",
            location: "/play/alice/session-406",
          },
          "remote-offer",
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    expect((await session.start(new AbortController().signal)).isOk()).toBe(
      true,
    );
    expect(peerConnection().setLocalDescription).toHaveBeenCalledWith({
      type: "rollback",
    });
    expect(peerConnection().setRemoteDescription).toHaveBeenCalledWith(
      expect.objectContaining({ type: "offer", sdp: "remote-offer" }),
    );
    expect(peerConnection().createAnswer).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      new URL("/play/alice/session-406", window.location.origin),
      expect.objectContaining({ method: "PATCH", body: "local-answer" }),
    );
    await session.dispose();
  });

  it.each([
    [200, "unexpected_response"],
    [500, "server_request_error"],
  ] as const)(
    "rejects a counter-offer PATCH response with status %i",
    async (status, kind) => {
      const session = createSession();
      const fetch = vi.spyOn(globalThis, "fetch");
      fetch
        .mockResolvedValueOnce(
          sdpResponse(406, {
            "content-type": "application/sdp",
            location: "/play/alice/session-406",
          }),
        )
        .mockResolvedValueOnce(new Response("  \n ", { status }))
        .mockResolvedValueOnce(new Response(null, { status: 204 }));

      const result = await session.start(new AbortController().signal);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error).toMatchObject({
          kind,
          message: `Unexpected WHEP answer response: ${String(status)}`,
          responseText: undefined,
          retryable: true,
          stage: "patch",
        });
      }
      expect(fetch).toHaveBeenCalledTimes(3);
      expect(fetch.mock.calls[2]?.[1]).toEqual({ method: "DELETE" });
    },
  );

  it("rejects a counter-offer when the browser does not produce answer SDP", async () => {
    const session = createSession();
    const connection = peerConnection();
    connection.setLocalDescription.mockImplementation(async (description) => {
      connection.localDescription =
        description?.type === "answer"
          ? { type: "answer" }
          : {
              type: description?.type ?? "offer",
              sdp: description?.sdp ?? "local-offer",
            };
    });
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch
      .mockResolvedValueOnce(
        sdpResponse(
          406,
          {
            "content-type": "application/sdp",
            location: "/play/alice/session-406",
          },
          "remote-offer",
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await session.start(new AbortController().signal);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe("Failed to create local SDP answer");
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]).toEqual({ method: "DELETE" });
  });

  it("cleans up the registered session after a failed counter-offer PATCH", async () => {
    const session = createSession();
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch
      .mockResolvedValueOnce(
        sdpResponse(
          406,
          {
            "content-type": "application/sdp",
            location: "/play/alice/session-406",
          },
          "remote-offer",
        ),
      )
      .mockResolvedValueOnce(new Response("patch refused", { status: 422 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await session.start(new AbortController().signal);

    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error).toMatchObject({
        kind: "client_request_error",
        stage: "patch",
      });
    expect(fetch).toHaveBeenLastCalledWith(
      new URL("/play/alice/session-406", window.location.origin),
      { method: "DELETE" },
    );
  });

  it("does not wait for ICE when gathering is already complete or the peer is closed", async () => {
    const session = createSession();
    const connection = peerConnection();
    connection.iceGatheringState = "gathering";
    connection.connectionState = "closed";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sdpResponse());

    expect((await session.start(new AbortController().signal)).isOk()).toBe(
      true,
    );
    await session.dispose({ notifyServer: false });
  });

  it("finishes gathering when signaling or connection state is closed", async () => {
    const signalingSession = createSession();
    const signalingConnection = peerConnection();
    signalingConnection.iceGatheringState = "gathering";
    signalingConnection.signalingState = "closed";
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sdpResponse());
    fetch.mockResolvedValue(sdpResponse());
    expect(
      (await signalingSession.start(new AbortController().signal)).isOk(),
    ).toBe(true);
    await signalingSession.dispose({ notifyServer: false });

    const connectionSession = createSession();
    const connection = peerConnection();
    connection.iceGatheringState = "gathering";
    connection.connectionState = "closed";
    fetch.mockResolvedValue(sdpResponse());
    expect(
      (await connectionSession.start(new AbortController().signal)).isOk(),
    ).toBe(true);
    await connectionSession.dispose({ notifyServer: false });
  });

  it("waits for ICE completion events and removes listeners when complete", async () => {
    const session = createSession();
    const connection = peerConnection();
    connection.iceGatheringState = "gathering";
    const addEventListener = vi.spyOn(connection, "addEventListener");
    const removeEventListener = vi.spyOn(connection, "removeEventListener");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sdpResponse());

    const started = session.start(new AbortController().signal);
    await vi.waitFor(() => {
      expect(addEventListener).toHaveBeenCalledWith(
        "icegatheringstatechange",
        expect.any(Function),
      );
    });
    connection.emit("icegatheringstatechange");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(fetch).not.toHaveBeenCalled();
    let startSettled = false;
    void started.then(() => {
      startSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    if (startSettled) {
      throw new Error("ICE progress must not finish gathering");
    }

    connection.iceGatheringState = "complete";
    connection.emit("icegatheringstatechange");

    expect((await started).isOk()).toBe(true);
    expect(removeEventListener.mock.calls.map(([type]) => type)).toEqual([
      "icegatheringstatechange",
      "connectionstatechange",
      "signalingstatechange",
    ]);
    expect(addEventListener.mock.calls.map(([type]) => type)).toEqual([
      "icegatheringstatechange",
      "connectionstatechange",
      "signalingstatechange",
    ]);
    await session.dispose({ notifyServer: false });
  });

  it("aborts ICE gathering and skips the offer POST", async () => {
    const session = createSession();
    const connection = peerConnection();
    connection.iceGatheringState = "gathering";
    const fetch = vi.spyOn(globalThis, "fetch");
    const controller = new AbortController();
    const abortSignal = controller.signal;
    vi.spyOn(AbortSignal, "any").mockReturnValue(abortSignal);
    const addAbortListener = vi.spyOn(abortSignal, "addEventListener");
    const removeAbortListener = vi.spyOn(abortSignal, "removeEventListener");
    const addEventListener = vi.spyOn(connection, "addEventListener");
    const removeEventListener = vi.spyOn(connection, "removeEventListener");

    const started = session.start(controller.signal);
    await vi.waitFor(() => {
      expect(addEventListener).toHaveBeenCalledWith(
        "icegatheringstatechange",
        expect.any(Function),
      );
    });
    controller.abort();
    const result = await started;

    expect(result.isOk()).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(removeEventListener.mock.calls.map(([type]) => type)).toEqual([
      "icegatheringstatechange",
      "connectionstatechange",
      "signalingstatechange",
    ]);
    expect(addAbortListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
      { once: true },
    );
    expect(removeAbortListener).toHaveBeenCalledWith(
      "abort",
      expect.any(Function),
    );
  });

  it("finishes ICE gathering when the connection closes during gathering", async () => {
    const session = createSession();
    const connection = peerConnection();
    connection.iceGatheringState = "gathering";
    const addEventListener = vi.spyOn(connection, "addEventListener");
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sdpResponse());

    const started = session.start(new AbortController().signal);
    await vi.waitFor(() => {
      expect(addEventListener).toHaveBeenCalledWith(
        "connectionstatechange",
        expect.any(Function),
      );
    });
    connection.connectionState = "closed";
    connection.emit("connectionstatechange");

    expect((await started).isOk()).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    await session.dispose({ notifyServer: false });
  });

  it("does not PATCH if cancellation happens before counter-offer ICE gathering", async () => {
    const session = createSession();
    const controller = new AbortController();
    const connection = peerConnection();
    connection.createAnswer.mockImplementation(async () => {
      controller.abort();
      return { type: "answer", sdp: "local-answer" };
    });
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      sdpResponse(
        406,
        {
          "content-type": "application/sdp",
          location: "/play/alice/session-406",
        },
        "remote-offer",
      ),
    );

    expect((await session.start(controller.signal)).isOk()).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    await session.dispose({ notifyServer: false });
  });

  it("reports connection and stream state as media tracks are muted or removed", async () => {
    const onStatusChange = vi.fn();
    const onStreamChange = vi.fn();
    const video = videoElement();
    const session = new WHEPSession({
      callbacks: { onStatusChange, onStreamChange },
      resourceUserId: "alice",
      videoElement: video,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sdpResponse());
    await session.start(new AbortController().signal);
    const connection = peerConnection();
    connection.connectionState = "connected";
    connection.iceConnectionState = "connected";
    connection.emit("connectionstatechange");
    const track = new MockTrack() as FakeTrack;
    video.srcObject = null;
    connection.emitTrack(track);

    expect(onStatusChange).toHaveBeenCalledWith("connected");
    expect(onStreamChange).toHaveBeenCalledWith(true);
    expect(session.getSnapshot()).toMatchObject({
      hasStream: true,
      liveTrackCount: 1,
      remoteTrackCount: 1,
    });
    track.muted = true;
    track.dispatchEvent(new Event("mute"));
    expect(onStreamChange).toHaveBeenLastCalledWith(false);
    track.muted = false;
    track.dispatchEvent(new Event("unmute"));
    expect(onStreamChange).toHaveBeenLastCalledWith(true);
    connection.iceConnectionState = "failed";
    connection.emit("iceconnectionstatechange");
    expect(onStreamChange).toHaveBeenLastCalledWith(false);
    MockMediaStream.instances[0]?.removeTrack(track);
    expect(session.getSnapshot()).toMatchObject({
      expectedRemoteTrackCount: 1,
      remoteTrackCount: 0,
    });

    await session.dispose({ notifyServer: false });
    expect(track.stop).not.toHaveBeenCalled();
    expect(video.srcObject).toBeNull();
  });

  it("counts every receiver but considers any live unmuted track playable", async () => {
    const onStreamChange = vi.fn();
    const session = createSession({ onStreamChange });
    const connection = peerConnection();
    connection.connectionState = "connected";
    connection.iceConnectionState = "connected";
    connection.emit("connectionstatechange");
    const mutedTrack = new MockTrack() as FakeTrack;
    mutedTrack.muted = true;
    const liveTrack = new MockTrack() as FakeTrack;
    liveTrack.id = "live-track";
    connection.emitTrack(mutedTrack);
    connection.emitTrack(liveTrack);

    expect(session.getSnapshot()).toMatchObject({
      hasStream: true,
      liveTrackCount: 2,
      mutedTrackCount: 1,
      remoteTrackCount: 2,
    });

    liveTrack.muted = true;
    liveTrack.dispatchEvent(new Event("mute"));
    expect(session.getSnapshot().hasStream).toBe(false);
    liveTrack.muted = false;
    liveTrack.dispatchEvent(new Event("unmute"));
    expect(session.getSnapshot().hasStream).toBe(true);
    mutedTrack.readyState = "ended";
    mutedTrack.dispatchEvent(new Event("ended"));
    liveTrack.readyState = "ended";
    liveTrack.dispatchEvent(new Event("ended"));
    expect(session.getSnapshot()).toMatchObject({
      hasStream: false,
      liveTrackCount: 0,
      remoteTrackCount: 2,
    });
    expect(onStreamChange.mock.calls.map(([hasStream]) => hasStream)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    await session.dispose({ notifyServer: false });
  });

  it("updates stream state when tracks are added to or removed from the remote stream", async () => {
    const onStreamChange = vi.fn();
    const video = videoElement();
    const session = new WHEPSession({
      callbacks: { onStreamChange },
      resourceUserId: "alice",
      videoElement: video,
    });
    const connection = peerConnection();
    connection.connectionState = "connected";
    connection.iceConnectionState = "connected";
    connection.emit("connectionstatechange");
    const stream = video.srcObject as unknown as MockMediaStream;
    const track = new MockTrack() as FakeTrack;

    stream.addTrack(track);
    expect(session.getSnapshot()).toMatchObject({
      hasStream: true,
      remoteTrackCount: 1,
      status: "connected",
    });
    stream.removeTrack(track);
    expect(session.getSnapshot()).toMatchObject({
      hasStream: false,
      remoteTrackCount: 0,
      status: "connected",
    });
    expect(onStreamChange.mock.calls.map(([hasStream]) => hasStream)).toEqual([
      true,
      false,
    ]);

    await session.dispose({ notifyServer: false });
  });

  it("removes peer, stream, and track listeners exactly once on disposal", async () => {
    const session = createSession();
    const connection = peerConnection();
    const stream = MockMediaStream.instances.at(-1);
    if (!stream) throw new Error("Expected the session's remote stream");
    const track = new MockTrack() as FakeTrack;
    const removePeerListener = vi.spyOn(connection, "removeEventListener");
    const removeStreamListener = vi.spyOn(stream, "removeEventListener");
    const removeTrackListener = vi.spyOn(track, "removeEventListener");
    connection.emitTrack(track);

    await session.dispose({ notifyServer: false });
    const peerCleanupCalls = removePeerListener.mock.calls.length;
    const streamCleanupCalls = removeStreamListener.mock.calls.length;
    const trackCleanupCalls = removeTrackListener.mock.calls.length;
    await session.dispose({ notifyServer: false });

    expect(removePeerListener.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining([
        "connectionstatechange",
        "iceconnectionstatechange",
        "icegatheringstatechange",
        "signalingstatechange",
        "icecandidate",
        "negotiationneeded",
        "icecandidateerror",
        "track",
      ]),
    );
    expect(removeStreamListener.mock.calls.map(([type]) => type)).toEqual([
      "addtrack",
      "removetrack",
    ]);
    expect(removeTrackListener.mock.calls.map(([type]) => type)).toEqual([
      "mute",
      "unmute",
      "ended",
    ]);
    expect(removePeerListener).toHaveBeenCalledTimes(peerCleanupCalls);
    expect(removeStreamListener).toHaveBeenCalledTimes(streamCleanupCalls);
    expect(removeTrackListener).toHaveBeenCalledTimes(trackCleanupCalls);
  });

  it("attaches remote track listeners once and removes them on track end", async () => {
    const onStreamChange = vi.fn();
    const session = createSession({ onStreamChange });
    const connection = peerConnection();
    connection.connectionState = "connected";
    connection.iceConnectionState = "connected";
    connection.emit("connectionstatechange");
    const track = new MockTrack() as FakeTrack;
    const stream = MockMediaStream.instances.at(-1);
    if (!stream) throw new Error("Expected the session's remote stream");
    const addListener = vi.spyOn(track, "addEventListener");
    const removeListener = vi.spyOn(track, "removeEventListener");
    connection.emitTrack(track);
    connection.emitTrack(track);
    track.readyState = "ended";
    track.dispatchEvent(new Event("ended"));
    stream.removeTrack(track);
    stream.addTrack(track);
    track.readyState = "live";
    track.dispatchEvent(new Event("unmute"));
    stream.removeTrack(track);

    expect(addListener.mock.calls.map(([type]) => type)).toEqual([
      "mute",
      "unmute",
      "ended",
      "mute",
      "unmute",
      "ended",
    ]);
    expect(removeListener.mock.calls.map(([type]) => type)).toEqual([
      "mute",
      "unmute",
      "ended",
      "mute",
      "unmute",
      "ended",
    ]);
    expect(onStreamChange.mock.calls.map(([hasStream]) => hasStream)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    await session.dispose({ notifyServer: false });
  });

  it("ignores late peer and media events after disposal", async () => {
    const onStatusChange = vi.fn();
    const onStreamChange = vi.fn();
    const video = videoElement();
    const session = new WHEPSession({
      callbacks: { onStatusChange, onStreamChange },
      resourceUserId: "alice",
      videoElement: video,
    });
    const connection = peerConnection();
    const stream = MockMediaStream.instances.at(-1);
    if (!stream) throw new Error("Expected the session's remote stream");
    const existingTrack = new MockTrack() as FakeTrack;
    stream.addTrack(existingTrack);
    vi.spyOn(existingTrack, "removeEventListener").mockImplementation(
      () => undefined,
    );

    vi.spyOn(connection, "removeEventListener").mockImplementation(
      () => undefined,
    );
    vi.spyOn(stream, "removeEventListener").mockImplementation(() => undefined);
    const statusCallsBeforeDispose = onStatusChange.mock.calls.length;
    const streamCallsBeforeDispose = onStreamChange.mock.calls.length;

    await session.dispose({ notifyServer: false });
    connection.connectionState = "connected";
    connection.iceConnectionState = "connected";
    connection.emit("connectionstatechange");
    connection.emit("icecandidateerror");
    connection.emitTrack(new MockTrack());
    stream.addTrack(new MockTrack());
    stream.removeTrack(existingTrack);

    expect(onStatusChange).toHaveBeenCalledTimes(statusCallsBeforeDispose);
    expect(onStreamChange).toHaveBeenCalledTimes(streamCallsBeforeDispose);
    expect(video.srcObject).toBeNull();
  });

  it("stops remote media tracks on disposal and logs autoplay rejection", async () => {
    const video = videoElement();
    vi.spyOn(video, "play").mockRejectedValue(new Error("autoplay blocked"));
    const session = new WHEPSession({
      resourceUserId: "alice",
      videoElement: video,
    });
    const connection = peerConnection();
    const track = new MockTrack() as FakeTrack;
    connection.emitTrack(track);
    await Promise.resolve();
    expect(console.warn).toHaveBeenCalledWith(
      "Autoplay failed:",
      expect.any(Error),
    );

    await session.dispose({ notifyServer: false });
    expect(track.stop).toHaveBeenCalledOnce();
    expect(session.getSnapshot().status).toBe("disconnected");
  });

  it("derives disconnected, failed, and connected statuses from peer state", async () => {
    const onStatusChange = vi.fn();
    const session = createSession({ onStatusChange });
    const connection = peerConnection();
    connection.iceConnectionState = "failed";
    connection.emit("iceconnectionstatechange");
    expect(session.getSnapshot().status).toBe("failed");
    connection.iceConnectionState = "disconnected";
    connection.emit("iceconnectionstatechange");
    expect(session.getSnapshot().status).toBe("disconnected");
    connection.iceConnectionState = "completed";
    connection.connectionState = "connected";
    connection.emit("connectionstatechange");
    expect(session.getSnapshot().status).toBe("connected");
    expect(onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      "failed",
      "disconnected",
      "connected",
    ]);
    await session.dispose({ notifyServer: false });
  });

  it.each([
    ["new", "new", "stable", "connecting"],
    ["checking", "connecting", "stable", "connecting"],
    ["connected", "connected", "stable", "connected"],
    ["completed", "connected", "stable", "connected"],
    ["connected", "connected", "closed", "disconnected"],
    ["connected", "closed", "stable", "disconnected"],
    ["failed", "connected", "stable", "failed"],
    ["disconnected", "connected", "stable", "disconnected"],
    ["new", "connected", "stable", "connecting"],
    ["checking", "connected", "stable", "connecting"],
    ["connected", "failed", "stable", "failed"],
    ["connected", "disconnected", "stable", "connecting"],
    ["closed", "connected", "stable", "disconnected"],
  ] as const)(
    "derives status for ICE %s, peer %s, and signaling %s",
    async (iceState, connectionState, signalingState, expected) => {
      const session = createSession();
      const connection = peerConnection();
      connection.iceConnectionState = iceState;
      connection.connectionState = connectionState;
      connection.signalingState = signalingState;
      connection.emit("connectionstatechange");

      const actual = session.getSnapshot().status;
      if (actual !== expected) {
        throw new Error(`Expected status ${expected}, received ${actual}`);
      }
      expect(actual).toBe(expected);
      await session.dispose({ notifyServer: false });
    },
  );

  it("preserves stream state and avoids duplicate callbacks for a stable connection", async () => {
    const onStatusChange = vi.fn();
    const onStreamChange = vi.fn();
    const session = createSession({ onStatusChange, onStreamChange });
    const connection = peerConnection();
    connection.connectionState = "connected";
    connection.iceConnectionState = "connected";
    connection.emit("connectionstatechange");
    const track = new MockTrack() as FakeTrack;
    connection.emitTrack(track);
    connection.emit("connectionstatechange");

    expect(session.getSnapshot().hasStream).toBe(true);
    expect(onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      "connected",
    ]);
    expect(onStreamChange.mock.calls.map(([hasStream]) => hasStream)).toEqual([
      true,
    ]);
    await session.dispose({ notifyServer: false });
  });

  it("discovers media delivered before the connection becomes established", async () => {
    const onStreamChange = vi.fn();
    const session = createSession({ onStreamChange });
    const connection = peerConnection();
    connection.emitTrack(new MockTrack());
    expect(session.getSnapshot().hasStream).toBe(false);

    connection.connectionState = "connected";
    connection.iceConnectionState = "connected";
    connection.emit("connectionstatechange");

    expect(session.getSnapshot().hasStream).toBe(true);
    expect(onStreamChange).toHaveBeenLastCalledWith(true);
    await session.dispose({ notifyServer: false });
    expect(session.getSnapshot().hasStream).toBe(false);
    expect(onStreamChange).toHaveBeenLastCalledWith(false);
  });

  it("handles media changes without optional callbacks or a track cleanup", async () => {
    const video = videoElement();
    const session = new WHEPSession({
      resourceUserId: "alice",
      videoElement: video,
    });
    const connection = peerConnection();
    connection.connectionState = "connected";
    connection.iceConnectionState = "connected";
    connection.emit("connectionstatechange");

    const stream = video.srcObject as unknown as MockMediaStream;
    let cleanupThrew = false;
    try {
      stream.removeTrack(new MockTrack());
    } catch {
      cleanupThrew = true;
    }
    if (cleanupThrew) {
      throw new Error("Removing a track without a registered cleanup is safe");
    }

    connection.emitTrack(new MockTrack());
    connection.connectionState = "failed";
    connection.iceConnectionState = "failed";
    connection.emit("connectionstatechange");
    expect(session.getSnapshot()).toMatchObject({
      hasStream: false,
      status: "failed",
    });
    await session.dispose({ notifyServer: false });
  });

  it("extracts inbound audio/video receiver stats by MID or track id", async () => {
    const session = createSession();
    const connection = peerConnection();
    const audioTrack = { id: "audio-track", kind: "audio" } as Pick<
      FakeTrack,
      "id" | "kind"
    >;
    const videoTrack = { id: "video-track", kind: "video" } as Pick<
      FakeTrack,
      "id" | "kind"
    >;
    const unknownTrack = { id: "data-track", kind: "data" } as Pick<
      FakeTrack,
      "id" | "kind"
    >;
    const receiver = (
      track: Pick<FakeTrack, "id" | "kind">,
      reports: unknown[],
    ): FakeReceiver => ({
      track,
      getStats: async () => ({
        forEach: (callback) => {
          reports.forEach((report) => {
            callback(report);
          });
        },
      }),
    });
    const audio = receiver(audioTrack, [
      null,
      { type: "outbound-rtp", bytesReceived: 8 },
      { type: "inbound-rtp", bytesReceived: 12 },
      { type: "inbound-rtp", bytesReceived: 15 },
    ]);
    const video = receiver(videoTrack, [
      { type: "inbound-rtp", bytesReceived: 20 },
    ]);
    connection.receivers.push(
      audio,
      video,
      receiver(unknownTrack, [{ type: "inbound-rtp", bytesReceived: 40 }]),
    );
    connection.transceivers.push(
      { mid: "audio-mid", receiver: audio },
      { mid: "", receiver: video },
    );

    await expect(session.getInboundReceiverStats()).resolves.toEqual([
      { bytesReceived: 12, id: "audio-mid", kind: "audio" },
      { bytesReceived: 20, id: "video-track", kind: "video" },
    ]);
    await session.dispose({ notifyServer: false });
  });

  it("ignores receiver stats without valid inbound byte counts or receiver ids", async () => {
    const session = createSession();
    const connection = peerConnection();
    const noBytes = { id: "no-bytes", kind: "video" } as Pick<
      FakeTrack,
      "id" | "kind"
    >;
    const noId = { id: "", kind: "audio" } as Pick<FakeTrack, "id" | "kind">;
    const receiver = (
      track: Pick<FakeTrack, "id" | "kind">,
      reports: unknown[],
    ): FakeReceiver => ({
      track,
      getStats: async () => ({
        forEach: (callback) => {
          reports.forEach((report) => {
            callback(report);
          });
        },
      }),
    });
    connection.receivers.push(
      receiver(noBytes, [
        null,
        undefined,
        "not a report",
        17,
        { type: "outbound-rtp", bytesReceived: 10 },
        { type: "inbound-rtp", bytesReceived: "10" },
      ]),
      receiver(noId, [{ type: "inbound-rtp", bytesReceived: 0 }]),
    );

    await expect(session.getInboundReceiverStats()).resolves.toEqual([]);
    await session.dispose({ notifyServer: false });
  });

  it("keeps the first valid inbound byte count for arbitrary byte totals", async () => {
    await fc.assert(
      fc.asyncProperty(fc.nat({ max: 1_000_000 }), async (bytesReceived) => {
        const session = createSession();
        const connection = peerConnection();
        const track = { id: "video-track", kind: "video" } as Pick<
          FakeTrack,
          "id" | "kind"
        >;
        const receiver: FakeReceiver = {
          track,
          getStats: async () => ({
            forEach: (callback) => {
              callback(null);
              callback({ type: "inbound-rtp", bytesReceived: "0" });
              callback({ type: "inbound-rtp", bytesReceived });
              callback({
                type: "inbound-rtp",
                bytesReceived: bytesReceived + 1,
              });
            },
          }),
        };
        connection.receivers.push(receiver);
        connection.transceivers.push({ mid: "", receiver });

        await expect(session.getInboundReceiverStats()).resolves.toEqual([
          { bytesReceived, id: "video-track", kind: "video" },
        ]);
        await session.dispose({ notifyServer: false });
      }),
      { numRuns: 25 },
    );
  });

  it("logs ICE candidate errors only while active", async () => {
    const session = createSession();
    const connection = peerConnection();
    const event = Object.assign(new Event("icecandidateerror"), {
      errorCode: 701,
      errorText: "TURN unreachable",
      url: "turn:relay.example",
    });
    connection.dispatchEvent(event);
    expect(console.warn).toHaveBeenCalledWith("ICE candidate error:", {
      errorCode: 701,
      errorText: "TURN unreachable",
      url: "turn:relay.example",
    });
    await session.dispose({ notifyServer: false });
    connection.dispatchEvent(event);
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it("warns when server-session deletion fails or returns an error status", async () => {
    const session = createSession();
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch
      .mockResolvedValueOnce(sdpResponse())
      .mockResolvedValueOnce(new Response("  ", { status: 500 }));
    await session.start(new AbortController().signal);
    await session.dispose();
    expect(console.warn).toHaveBeenCalledWith(
      "Failed to close WHEP session:",
      expect.objectContaining({
        kind: "server_request_error",
        message: "Unexpected WHEP delete response: 500",
        responseText: undefined,
        stage: "delete",
      }),
    );

    const failedFetchSession = createSession();
    fetch
      .mockResolvedValueOnce(sdpResponse())
      .mockRejectedValueOnce(new Error("offline"));
    await failedFetchSession.start(new AbortController().signal);
    await failedFetchSession.dispose();
    expect(console.warn).toHaveBeenCalledWith(
      "Failed to close WHEP session:",
      expect.any(Error),
    );
    expect(console.warn).toHaveBeenLastCalledWith(
      "Failed to close WHEP session:",
      expect.objectContaining({ message: "offline" }),
    );
  });

  it("does not repeat close work across concurrent and repeated disposal", async () => {
    const session = createSession();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(sdpResponse());
    await session.start(new AbortController().signal);

    await Promise.all([session.dispose(), session.dispose()]);
    await session.dispose();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(peerConnection().close).toHaveBeenCalledOnce();
  });

  it("returns a network error when offer registration rejects", async () => {
    const session = createSession();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("network offline"),
    );

    const result = await session.start(new AbortController().signal);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toBe("network offline");
  });

  it("deletes a registered session after counter-offer PATCH fetch rejects", async () => {
    const session = createSession();
    const fetch = vi.spyOn(globalThis, "fetch");
    fetch
      .mockResolvedValueOnce(
        sdpResponse(
          406,
          {
            "content-type": "application/sdp",
            location: "/play/alice/session-406",
          },
          "remote-offer",
        ),
      )
      .mockRejectedValueOnce(new Error("patch network offline"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    const result = await session.start(new AbortController().signal);

    expect(result.isErr()).toBe(true);
    if (result.isErr())
      expect(result.error.message).toBe("patch network offline");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[2]?.[1]).toEqual({ method: "DELETE" });
  });

  it("waits for an in-flight registration before deleting its created session", async () => {
    const session = createSession();
    let resolvePost: ((response: Response) => void) | undefined;
    const postSignal: { current: AbortSignal | null } = { current: null };
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input, init) => {
        if (init?.method === "DELETE") {
          return Promise.resolve(new Response(null, { status: 204 }));
        }
        postSignal.current = init?.signal ?? null;
        return new Promise((resolve) => {
          resolvePost = resolve;
        });
      });

    const started = session.start(new AbortController().signal);
    expect(turnMocks.fetchTurnIceServers).toHaveBeenCalledOnce();
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 0);
    });
    expect(fetch).toHaveBeenCalledOnce();
    const disposed = session.dispose();
    expect(postSignal.current?.aborted).toBe(true);
    resolvePost?.(sdpResponse());

    expect((await started).isOk()).toBe(true);
    await disposed;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]).toEqual({ method: "DELETE" });
    expect(peerConnection().setRemoteDescription).not.toHaveBeenCalled();
  });

  it("notifies listeners when disposing a connected session that has media", async () => {
    const onStreamChange = vi.fn();
    const session = createSession({ onStreamChange });
    const connection = peerConnection();
    connection.connectionState = "connected";
    connection.iceConnectionState = "connected";
    connection.emit("connectionstatechange");
    connection.emitTrack(new MockTrack());

    expect(session.getSnapshot().hasStream).toBe(true);
    expect(onStreamChange).toHaveBeenLastCalledWith(true);
    await session.dispose({ notifyServer: false });
    expect(session.getSnapshot().hasStream).toBe(false);
    expect(onStreamChange).toHaveBeenLastCalledWith(false);
  });

  it("makes reentrant disposal during disconnect idempotent", async () => {
    let session: WHEPSession;
    let reentrantDispose: Promise<void> | undefined;
    const onStatusChange = vi.fn((status) => {
      if (status === "disconnected") {
        reentrantDispose = session.dispose({ notifyServer: false });
      }
    });
    session = new WHEPSession({
      callbacks: { onStatusChange },
      resourceUserId: "alice",
      videoElement: videoElement(),
    });
    const connection = peerConnection();
    connection.connectionState = "connected";
    connection.iceConnectionState = "connected";
    connection.emit("connectionstatechange");

    await session.dispose({ notifyServer: false });
    await reentrantDispose;

    expect(connection.close).toHaveBeenCalledOnce();
    expect(onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      "connected",
      "disconnected",
    ]);
  });
});
