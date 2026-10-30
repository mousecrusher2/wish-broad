import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeTracks,
  isSessionActive,
  LiveNotFoundError,
  renegotiateSession,
  SfuApiError,
  startIngest,
  startPlay,
} from "./sfu";

const env = { CALLS_APP_ID: "app-id", CALLS_APP_SECRET: "app-secret" };
const baseUrl = "https://rtc.live.cloudflare.com/v1/apps/app-id/sessions";
const tracks = [
  {
    location: "remote",
    mid: "audio-mid",
    sessionId: "ingest",
    trackName: "audio",
  },
  {
    location: "remote",
    mid: "video-mid",
    sessionId: "ingest",
    trackName: "video",
  },
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function sessionResponse(): Response {
  return jsonResponse({ sessionId: "playback" });
}

function requestBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new TypeError("Expected an SFU JSON request body");
  }
  return body;
}

function trackResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    sessionDescription: { sdp: "v=0\r\n", type: "answer" },
    tracks: [{ mid: "remote-mid", trackName: "audio" }],
    ...overrides,
  });
}

function expectErr<T>(result: { isErr: () => boolean; error?: T }): T {
  expect(result.isErr()).toBe(true);
  if (!result.isErr() || result.error === undefined) {
    throw new Error("Expected a failed result");
  }
  return result.error;
}

describe("SFU API", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates an ingest session and records each returned MID", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(sessionResponse()).mockResolvedValueOnce(
      jsonResponse({
        sessionDescription: { sdp: "answer-sdp", type: "answer" },
        tracks: [
          { mid: "0", trackName: "audio" },
          { mid: "1", trackName: "video" },
        ],
      }),
    );

    const result = await startIngest(env, "live-id", "offer-sdp");

    expect(result._unsafeUnwrap()).toEqual({
      sessionId: "playback",
      sdpAnswer: "answer-sdp",
      tracks: [
        {
          location: "remote",
          sessionId: "playback",
          trackName: "audio",
          mid: "0",
        },
        {
          location: "remote",
          sessionId: "playback",
          trackName: "video",
          mid: "1",
        },
      ],
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(`${baseUrl}/new`);
    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { Authorization: "Bearer app-secret" },
    });
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(`${baseUrl}/playback/tracks/new`);
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      headers: {
        Authorization: "Bearer app-secret",
        "Content-Type": "application/json",
      },
      method: "POST",
    });
    expect(JSON.parse(requestBody(fetchSpy.mock.calls[1]?.[1]))).toEqual({
      autoDiscover: true,
      sessionDescription: { type: "offer", sdp: "offer-sdp" },
    });
  });

  it.each([
    [
      "no tracks",
      { sessionDescription: { sdp: "answer", type: "answer" } },
      "invalid_sfu_response",
    ],
    [
      "empty tracks",
      { sessionDescription: { sdp: "answer", type: "answer" }, tracks: [] },
      "invalid_sfu_response",
    ],
    [
      "missing SDP",
      { tracks: [{ mid: "0", trackName: "audio" }] },
      "invalid_sfu_response",
    ],
    [
      "missing MID",
      {
        sessionDescription: { sdp: "answer", type: "answer" },
        tracks: [{ trackName: "audio" }],
      },
      "invalid_sfu_response",
    ],
    [
      "too many tracks",
      {
        sessionDescription: { sdp: "answer", type: "answer" },
        tracks: [0, 1, 2].map((index) => ({
          mid: String(index),
          trackName: `track-${String(index)}`,
        })),
      },
      "invalid_sfu_response",
    ],
  ] as const)("rejects ingest response with %s", async (_name, body, kind) => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(jsonResponse(body));

    const error = expectErr(await startIngest(env, "live-id", "offer"));
    expect(error).toBeInstanceOf(SfuApiError);
    expect(error.kind).toBe(kind);
    expect(error.message).toBe(
      _name === "too many tracks"
        ? "WHIP does not allow more than two ingest tracks"
        : _name === "missing MID"
          ? "SFU response did not include track MID"
          : "SFU response did not include ingest tracks or SDP",
    );
    expect(error.endpoint).toBe(`${baseUrl}/playback/tracks/new`);
  });

  it("rejects malformed session and ingest response schemas", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(jsonResponse({}));
    const badSession = expectErr(await startIngest(env, "live-id", "offer"));
    expect(badSession.kind).toBe("invalid_response_schema");
    expect(badSession.responseBody).toMatchObject({ responseBody: {} });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(jsonResponse({ tracks: "not-an-array" }));
    const badTracks = expectErr(await startIngest(env, "live-id", "offer"));
    expect(badTracks.kind).toBe("invalid_response_schema");
    expect(badTracks.responseBody).toMatchObject({
      responseBody: { tracks: "not-an-array" },
    });
  });

  it("reports an invalid JSON body and rejects a failed SFU request", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("not json"))
      .mockRejectedValueOnce(new TypeError("network down"));

    const invalidJson = expectErr(await startIngest(env, "live-id", "offer"));
    expect(invalidJson.kind).toBe("invalid_response_json");
    const jsonFailureBody = invalidJson.responseBody;
    if (
      typeof jsonFailureBody !== "object" ||
      jsonFailureBody === null ||
      !("error" in jsonFailureBody)
    ) {
      throw new Error("Expected SFU JSON parser error details");
    }
    expect(typeof jsonFailureBody.error).toBe("string");

    const requestFailed = expectErr(await startIngest(env, "live-id", "offer"));
    expect(requestFailed.kind).toBe("request_failed");
  });

  it("starts playback with normalized stored locators and an SDP offer", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(trackResponse());

    const result = await startPlay(env, "live-id", tracks, "viewer-offer");

    expect(result._unsafeUnwrap()).toEqual({
      sessionId: "playback",
      sdpAnswer: "v=0\r\n",
      sdpType: "answer",
      tracks: [
        {
          location: "remote",
          mid: "remote-mid",
          sessionId: "playback",
          trackName: "audio",
        },
      ],
    });
    expect(JSON.parse(requestBody(fetchSpy.mock.calls[1]?.[1]))).toEqual({
      sessionDescription: { type: "offer", sdp: "viewer-offer" },
      tracks: tracks.map(({ location, sessionId, trackName }) => ({
        location,
        sessionId,
        trackName,
      })),
    });
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(`${baseUrl}/playback/tracks/new`);
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer app-secret",
        "Content-Type": "application/json",
      },
    });
  });

  it("omits blank SDP offers and returns not found for an empty live", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(trackResponse());

    const result = await startPlay(env, "live-id", tracks, "  ");
    expect(result.isOk()).toBe(true);
    expect(JSON.parse(requestBody(fetchSpy.mock.calls[1]?.[1]))).toEqual({
      tracks: tracks.map(({ location, sessionId, trackName }) => ({
        location,
        sessionId,
        trackName,
      })),
    });
    expect(fetchSpy.mock.calls[1]?.[0]).toBe(`${baseUrl}/playback/tracks/new`);
    expect(fetchSpy.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        Authorization: "Bearer app-secret",
        "Content-Type": "application/json",
      },
    });

    const emptyResult = await startPlay(env, "gone-live", []);
    expect(expectErr(emptyResult)).toBeInstanceOf(LiveNotFoundError);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      "missing SDP",
      {
        sessionDescription: undefined,
        tracks: [{ mid: "0", trackName: "audio" }],
      },
      "invalid_sfu_response",
    ],
    [
      "missing tracks",
      {
        sessionDescription: { sdp: "answer", type: "answer" },
        tracks: undefined,
      },
      "invalid_sfu_response",
    ],
    [
      "empty tracks",
      { sessionDescription: { sdp: "answer", type: "answer" }, tracks: [] },
      "invalid_sfu_response",
    ],
    [
      "bad SDP type",
      {
        sessionDescription: { sdp: "answer", type: "pranswer" },
        tracks: [{ mid: "0", trackName: "audio" }],
      },
      "invalid_sfu_response",
    ],
    [
      "missing MID",
      {
        sessionDescription: { sdp: "answer", type: "offer" },
        tracks: [{ trackName: "audio" }],
      },
      "invalid_sfu_response",
    ],
    [
      "track error",
      { errorCode: "bad_track", tracks: [{ mid: "0", trackName: "audio" }] },
      "track_negotiation_error",
    ],
    [
      "track description error",
      {
        errorDescription: "could not connect",
        tracks: [{ mid: "0", trackName: "audio" }],
      },
      "track_negotiation_error",
    ],
    [
      "individual track error",
      { tracks: [{ mid: "0", trackName: "audio", errorCode: "bad_track" }] },
      "track_negotiation_error",
    ],
  ] as const)(
    "rejects playback response with %s",
    async (_name, body, kind) => {
      vi.spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(sessionResponse())
        .mockResolvedValueOnce(trackResponse(body));

      const error = expectErr(await startPlay(env, "live-id", tracks));
      if (!(error instanceof SfuApiError))
        throw new Error("Expected an SFU error");
      expect(error.kind).toBe(kind);
      const messages: Record<string, string> = {
        "missing SDP": "SFU response did not include SDP for playback",
        "missing tracks": "SFU response did not include playback tracks",
        "empty tracks": "SFU response did not include playback tracks",
        "bad SDP type":
          "SFU response did not include valid SDP type for playback",
        "missing MID": "SFU response did not include playback track MID",
        "track error": "SFU returned track negotiation errors",
        "track description error": "SFU returned track negotiation errors",
        "individual track error": "SFU returned track negotiation errors",
      };
      expect(error.message).toBe(messages[_name]);
      expect(error.endpoint).toBe(`${baseUrl}/playback/tracks/new`);
    },
  );

  it("renegotiates with an answer and maps recognized HTTP failures", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ ok: true }));
    expect(
      (await renegotiateSession(env, "session-1", "answer-sdp")).isOk(),
    ).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/session-1/renegotiate`,
      expect.objectContaining({
        method: "PUT",
        headers: {
          Authorization: "Bearer app-secret",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sessionDescription: { type: "answer", sdp: "answer-sdp" },
        }),
      }),
    );

    vi.restoreAllMocks();
    const cases = [
      [400, "bad_request"],
      [415, "unsupported_media_type"],
      [422, "unprocessable_content"],
      [404, "session_not_found"],
      [410, "session_gone"],
      [502, "http_error"],
    ] as const;
    let caseIndex = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      const testCase = cases[caseIndex];
      if (!testCase) throw new Error("Unexpected SFU HTTP case");
      caseIndex += 1;
      return Promise.resolve(new Response("failure", { status: testCase[0] }));
    });
    const results = await Promise.all(
      cases.map(() => renegotiateSession(env, "session-1", "answer")),
    );
    results.forEach((result, index) => {
      const testCase = cases[index];
      if (!testCase) throw new Error("Missing expected SFU HTTP case");
      const [status, kind] = testCase;
      const error = expectErr(result);
      expect(error.kind).toBe(kind);
      expect(error.isSessionNotFound()).toBe(status === 404);
      expect(error.responseBody).toBeNull();
    });
  });

  it("maps timeout errors and preserves negotiation-compatible client errors", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("timed out", "AbortError"),
    );
    const timeout = expectErr(
      await renegotiateSession(env, "session-1", "answer"),
    );
    expect(timeout.kind).toBe("request_timeout");
    expect(timeout.toNegotiationClientError("fallback")).toEqual({
      status: 504,
      text: "timed out",
    });
    expect(
      new SfuApiError("bad", {
        endpoint: "",
        kind: "bad_request",
        responseBody: "specific",
      }).toNegotiationClientError("fallback"),
    ).toEqual({ status: 400, text: "specific" });
    expect(
      new SfuApiError("bad", {
        endpoint: "",
        kind: "bad_request",
        responseBody: "",
      }).toNegotiationClientError("fallback"),
    ).toEqual({ status: 400, text: "fallback" });
    expect(
      new SfuApiError("other", {
        endpoint: "",
        kind: "http_error",
      }).toNegotiationClientError("fallback"),
    ).toBeNull();
  });

  it("closes tracks by MID and validates its response", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({ tracks: [{ mid: "audio-mid" }] }));

    expect(
      (await closeTracks(env, "session-1", tracks))._unsafeUnwrap(),
    ).toEqual({ tracks: [{ mid: "audio-mid" }] });
    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/session-1/tracks/close`,
      expect.objectContaining({
        method: "PUT",
        headers: {
          Authorization: "Bearer app-secret",
          "Content-Type": "application/json",
        },
      }),
    );
    expect(JSON.parse(requestBody(fetchSpy.mock.calls[0]?.[1]))).toEqual({
      force: true,
      tracks: [{ mid: "audio-mid" }, { mid: "video-mid" }],
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse({ tracks: "bad" }),
    );
    const schemaError = expectErr(await closeTracks(env, "session-1", tracks));
    expect(schemaError.kind).toBe("invalid_response_schema");
    expect(schemaError.responseBody).toMatchObject({
      responseBody: { tracks: "bad" },
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("invalid-json"),
    );
    const jsonError = expectErr(await closeTracks(env, "session-1", tracks));
    expect(jsonError.kind).toBe("invalid_response_json");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("close offline"),
    );
    const requestError = expectErr(await closeTracks(env, "session-1", tracks));
    expect(requestError).toMatchObject({
      kind: "request_failed",
      responseBody: "close offline",
    });
  });

  it("probes session activity: only not-found and gone are inactive", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(jsonResponse({}));
    expect((await isSessionActive(env, "session-1"))._unsafeUnwrap()).toBe(
      true,
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      `${baseUrl}/session-1`,
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer app-secret" },
      }),
    );

    vi.restoreAllMocks();
    let responseIndex = 0;
    const inactiveStatuses = [404, 410] as const;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => {
      const status = inactiveStatuses[responseIndex];
      if (status === undefined) throw new Error("Unexpected session probe");
      responseIndex += 1;
      return Promise.resolve(new Response("gone", { status }));
    });
    const inactiveResults = await Promise.all(
      inactiveStatuses.map(() => isSessionActive(env, "session-1")),
    );
    expect(inactiveResults.map((result) => result._unsafeUnwrap())).toEqual([
      false,
      false,
    ]);

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("error", { status: 503 }),
    );
    const httpError = expectErr(await isSessionActive(env, "session-1"));
    expect(httpError.kind).toBe("http_error");
    expect(httpError.responseBody).toBeNull();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("probe offline"),
    );
    expect(expectErr(await isSessionActive(env, "session-1")).kind).toBe(
      "request_failed",
    );
  });

  it("aborts an SFU request at its eight-second deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const pending = renegotiateSession(env, "session-1", "answer");
    await vi.advanceTimersByTimeAsync(8_000);
    expect(expectErr(await pending).kind).toBe("request_timeout");
    vi.useRealTimers();
  });
});
