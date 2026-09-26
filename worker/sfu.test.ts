import { afterEach, describe, expect, it, vi } from "vitest";
import type { Result } from "neverthrow";
import {
  closeTracks,
  isSessionActive,
  LiveNotFoundError,
  renegotiateSession,
  SfuApiError,
  startIngest,
  startPlay,
  type StoredTrack,
} from "./sfu";

const env = { CALLS_APP_ID: "app", CALLS_APP_SECRET: "secret" };
const base = "https://rtc.live.cloudflare.com/v1/apps/app/sessions";
const track: StoredTrack = {
  location: "remote",
  sessionId: "ingest",
  trackName: "video",
  mid: "0",
};

function reply(body: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Failed",
  });
}

function queue(...responses: Array<Response | Error>) {
  const mock = vi.fn<typeof fetch>();
  for (const response of responses) {
    if (response instanceof Error) mock.mockRejectedValueOnce(response);
    else mock.mockResolvedValueOnce(response);
  }
  vi.stubGlobal("fetch", mock);
  return mock;
}

function expectSfuFailure(
  result: Result<unknown, SfuApiError | LiveNotFoundError>,
  kind: string,
  message?: string,
) {
  expect(result.isErr()).toBe(true);
  if (result.isOk()) throw new Error("Expected an SFU error");
  expect(result.error).toBeInstanceOf(SfuApiError);
  expect(result.error).toMatchObject({ kind, ...(message ? { message } : {}) });
}

describe("Cloudflare Calls client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("classifies client errors without leaking untrusted response bodies", () => {
    const expected = [
      ["bad_request", 400],
      ["unsupported_media_type", 415],
      ["unprocessable_content", 422],
      ["request_timeout", 504],
    ] as const;
    for (const [kind, status] of expected) {
      const error = new SfuApiError("failed", {
        endpoint: "url",
        kind,
        responseBody: "details",
        statusText: "Bad",
      });
      expect(error).toMatchObject({
        name: "SfuApiError",
        endpoint: "url",
        statusText: "Bad",
      });
      expect(error.toNegotiationClientError("fallback")).toEqual({
        status,
        text: "details",
      });
      expect(error.isSessionNotFound()).toBe(false);
    }
    expect(
      new SfuApiError("missing", {
        endpoint: "url",
        kind: "session_not_found",
      }).isSessionNotFound(),
    ).toBe(true);
    expect(
      new SfuApiError("failed", {
        endpoint: "url",
        kind: "http_error",
        responseBody: { error: true },
      }).toNegotiationClientError("fallback"),
    ).toBeNull();
    expect(
      new SfuApiError("failed", {
        endpoint: "url",
        kind: "bad_request",
        responseBody: "",
      }).toNegotiationClientError("fallback"),
    ).toEqual({ status: 400, text: "fallback" });
    expect(new LiveNotFoundError("user")).toMatchObject({
      name: "LiveNotFoundError",
      message: "Live stream not found: user",
    });
  });

  it("creates an ingest session with an OBS offer and durable track locators", async () => {
    const fetchSpy = queue(
      reply({ sessionId: "ingest" }),
      reply({
        sessionDescription: { type: "answer", sdp: "answer-sdp" },
        tracks: [
          { trackName: "video", mid: "0" },
          { trackName: "audio", mid: "1" },
        ],
      }),
    );
    const result = await startIngest(env, "live", "offer-sdp");
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw result.error;
    expect(result.value).toEqual({
      sessionId: "ingest",
      sdpAnswer: "answer-sdp",
      tracks: [track, { ...track, trackName: "audio", mid: "1" }],
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      1,
      `${base}/new`,
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer secret" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      `${base}/ingest/tracks/new`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          sessionDescription: { type: "offer", sdp: "offer-sdp" },
          autoDiscover: true,
        }),
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
        },
      }),
    );
  });

  it.each([
    [
      { tracks: [], sessionDescription: { type: "answer", sdp: "sdp" } },
      "SFU response did not include ingest tracks or SDP",
    ],
    [
      { tracks: [{ trackName: "video", mid: "0" }] },
      "SFU response did not include ingest tracks or SDP",
    ],
    [
      {
        tracks: [
          { trackName: "video", mid: "0" },
          { trackName: "audio", mid: "1" },
          { trackName: "extra", mid: "2" },
        ],
        sessionDescription: { type: "answer", sdp: "sdp" },
      },
      "WHIP does not allow more than two ingest tracks",
    ],
    [
      {
        tracks: [{ trackName: "video" }],
        sessionDescription: { type: "answer", sdp: "sdp" },
      },
      "SFU response did not include track MID",
    ],
  ])(
    "rejects incomplete or unsupported ingest tracks: %s",
    async (payload, message) => {
      queue(reply({ sessionId: "ingest" }), reply(payload));
      await expectSfuFailure(
        await startIngest(env, "live", "offer"),
        "invalid_sfu_response",
        message,
      );
    },
  );

  it("creates playback with the stored locator and answer SDP", async () => {
    const fetchSpy = queue(
      reply({ sessionId: "viewer" }),
      reply({
        sessionDescription: { type: "answer", sdp: "answer-sdp" },
        tracks: [{ trackName: "video", mid: "2" }],
      }),
    );
    const result = await startPlay(env, "live", [track], "offer-sdp");
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw result.error;
    expect(result.value).toEqual({
      sessionId: "viewer",
      sdpAnswer: "answer-sdp",
      sdpType: "answer",
      tracks: [{ ...track, sessionId: "viewer", mid: "2" }],
    });
    expect(fetchSpy).toHaveBeenNthCalledWith(
      2,
      `${base}/viewer/tracks/new`,
      expect.objectContaining({
        body: JSON.stringify({
          sessionDescription: { type: "offer", sdp: "offer-sdp" },
          tracks: [
            { location: "remote", sessionId: "ingest", trackName: "video" },
          ],
        }),
      }),
    );
  });

  it("supports a counter-offer and an offer-less playback request", async () => {
    const fetchSpy = queue(
      reply({ sessionId: "viewer" }),
      reply({
        sessionDescription: { type: "offer", sdp: "counter" },
        tracks: [{ trackName: "video", mid: "2" }],
      }),
    );
    const result = await startPlay(env, "live", [track]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw result.error;
    expect(result.value.sdpType).toBe("offer");
    expect(fetchSpy.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        tracks: [
          { location: "remote", sessionId: "ingest", trackName: "video" },
        ],
      }),
    );
  });

  it("does not send a whitespace-only SDP offer to Calls", async () => {
    const fetchSpy = queue(
      reply({ sessionId: "viewer" }),
      reply({
        sessionDescription: { type: "offer", sdp: "counter" },
        tracks: [{ trackName: "video", mid: "2" }],
      }),
    );
    expect((await startPlay(env, "live", [track], "   ")).isOk()).toBe(true);
    expect(fetchSpy.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        tracks: [
          { location: "remote", sessionId: "ingest", trackName: "video" },
        ],
      }),
    );
  });

  it.each([
    { errorCode: "bad", tracks: [{ trackName: "video", mid: "0" }] },
    { errorDescription: "bad", tracks: [{ trackName: "video", mid: "0" }] },
    { tracks: [{ trackName: "video", mid: "0", errorCode: "bad" }] },
  ])("rejects Calls track negotiation errors: %s", async (failure) => {
    queue(
      reply({ sessionId: "viewer" }),
      reply({
        ...failure,
        sessionDescription: { type: "answer", sdp: "sdp" },
      }),
    );
    await expectSfuFailure(
      await startPlay(env, "live", [track], "offer"),
      "track_negotiation_error",
      "SFU returned track negotiation errors",
    );
  });

  it("rejects invalid Calls track response schema and transport failures", async () => {
    queue(
      reply({ sessionId: "viewer" }),
      reply({ tracks: [{ trackName: 17 }] }),
      reply({ sessionId: "viewer" }),
      new TypeError("offline"),
    );
    await expectSfuFailure(
      await startPlay(env, "live", [track]),
      "invalid_response_schema",
    );
    await expectSfuFailure(
      await startPlay(env, "live", [track]),
      "request_failed",
    );
  });

  it("propagates ingest track failures and invalid responses", async () => {
    queue(
      reply({ sessionId: "ingest" }),
      reply({ invalid: true }, 422),
      reply({ sessionId: "ingest" }),
      reply({ tracks: [{ trackName: 17 }] }),
      reply({ sessionId: "ingest" }),
      new TypeError("offline"),
    );
    await expectSfuFailure(
      await startIngest(env, "live", "offer"),
      "unprocessable_content",
    );
    await expectSfuFailure(
      await startIngest(env, "live", "offer"),
      "invalid_response_schema",
    );
    await expectSfuFailure(
      await startIngest(env, "live", "offer"),
      "request_failed",
    );
  });

  it.each([
    [
      { tracks: [{ trackName: "video", mid: "2" }] },
      "SFU response did not include SDP for playback",
    ],
    [
      { sessionDescription: { type: "answer", sdp: "sdp" }, tracks: [] },
      "SFU response did not include playback tracks",
    ],
    [
      {
        sessionDescription: { type: "invalid", sdp: "sdp" },
        tracks: [{ trackName: "video", mid: "2" }],
      },
      "SFU response did not include valid SDP type for playback",
    ],
    [
      {
        sessionDescription: { type: "answer", sdp: "sdp" },
        tracks: [{ trackName: "video" }],
      },
      "SFU response did not include playback track MID",
    ],
  ])("rejects invalid playback negotiations: %s", async (payload, message) => {
    queue(reply({ sessionId: "viewer" }), reply(payload));
    await expectSfuFailure(
      await startPlay(env, "live", [track], "offer"),
      "invalid_sfu_response",
      message,
    );
  });

  it("rejects absent live tracks before any SFU call", async () => {
    const fetchSpy = queue();
    const result = await startPlay(env, "missing", []);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected an error");
    expect(result.error).toBeInstanceOf(LiveNotFoundError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("renegotiates a counter-offer and maps HTTP failures", async () => {
    const success = reply({}, 204);
    const fetchSpy = queue(success, reply("invalid", 415));
    expect(await renegotiateSession(env, "viewer", "answer-sdp")).toMatchObject(
      { value: success },
    );
    expect(fetchSpy).toHaveBeenCalledWith(
      `${base}/viewer/renegotiate`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          sessionDescription: { type: "answer", sdp: "answer-sdp" },
        }),
      }),
    );
    await expectSfuFailure(
      await renegotiateSession(env, "viewer", "answer-sdp"),
      "unsupported_media_type",
      "SFU request failed: unsupported media type",
    );
  });

  it("propagates renegotiation transport errors", async () => {
    queue(new DOMException("aborted", "AbortError"));
    await expectSfuFailure(
      await renegotiateSession(env, "viewer", "answer"),
      "request_timeout",
    );
  });

  it("closes only the supplied mids and validates the result", async () => {
    const fetchSpy = queue(
      reply({ tracks: [{ mid: "0" }] }),
      reply({ tracks: [{ mid: 23 }] }),
    );
    const result = await closeTracks(env, "ingest", [track]);
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw result.error;
    expect(result.value).toEqual({ tracks: [{ mid: "0" }] });
    expect(fetchSpy).toHaveBeenCalledWith(
      `${base}/ingest/tracks/close`,
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ force: true, tracks: [{ mid: "0" }] }),
      }),
    );
    await expectSfuFailure(
      await closeTracks(env, "ingest", [track]),
      "invalid_response_schema",
    );
  });

  it("propagates close track network, HTTP, and JSON failures", async () => {
    queue(
      new TypeError("offline"),
      reply({ error: "invalid" }, 400),
      new Response("not json"),
    );
    await expectSfuFailure(
      await closeTracks(env, "ingest", [track]),
      "request_failed",
    );
    await expectSfuFailure(
      await closeTracks(env, "ingest", [track]),
      "bad_request",
    );
    await expectSfuFailure(
      await closeTracks(env, "ingest", [track]),
      "invalid_response_json",
    );
  });

  it("only treats missing or gone Calls sessions as inactive", async () => {
    queue(reply({}, 200), reply({}, 404), reply({}, 410), reply({}, 500));
    expect(await isSessionActive(env, "ingest")).toMatchObject({ value: true });
    expect(await isSessionActive(env, "ingest")).toMatchObject({
      value: false,
    });
    expect(await isSessionActive(env, "ingest")).toMatchObject({
      value: false,
    });
    await expectSfuFailure(await isSessionActive(env, "ingest"), "http_error");
  });

  it.each([
    [400, "bad_request"],
    [404, "session_not_found"],
    [410, "session_gone"],
    [415, "unsupported_media_type"],
    [422, "unprocessable_content"],
    [500, "http_error"],
  ] as const)(
    "classifies a failed session create (%i)",
    async (status, kind) => {
      queue(reply({ error: "failed" }, status));
      await expectSfuFailure(await startIngest(env, "live", "offer"), kind);
    },
  );

  it("reports invalid JSON and invalid session schema", async () => {
    queue(new Response("not json"), reply({ sessionId: 42 }));
    await expectSfuFailure(
      await startIngest(env, "live", "offer"),
      "invalid_response_json",
    );
    await expectSfuFailure(
      await startIngest(env, "live", "offer"),
      "invalid_response_schema",
    );
  });

  it("reports network and abort failures without treating them as stale sessions", async () => {
    queue(new TypeError("offline"), new DOMException("aborted", "AbortError"));
    await expectSfuFailure(
      await isSessionActive(env, "ingest"),
      "request_failed",
      "SFU request failed",
    );
    await expectSfuFailure(
      await isSessionActive(env, "ingest"),
      "request_timeout",
      "SFU request timed out",
    );
  });
});
