import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { patchWhepAnswer, postWhepOffer, WHEPSessionError } from "./signaling";

const ORIGIN = "http://localhost";
const SESSION_URL = new URL(`${ORIGIN}/play/alice/session-1?mid=0`);

function sdpResponse(
  status: number,
  headers: Record<string, string> = {},
  body = "remote-sdp",
): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/sdp",
      Location: "/play/alice/session-1?mid=0",
      ...headers,
    },
    status,
  });
}

/** リクエストが中断されるまで応答しない fetch。 */
function mockUnresponsiveFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(
            signal.reason instanceof Error ? signal.reason : new Error("abort"),
          );
        });
      }),
  );
}

async function postOfferError(response: Response): Promise<WHEPSessionError> {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
  const error: unknown = await postWhepOffer(
    "alice",
    "local-offer",
    new AbortController().signal,
  ).catch((caught: unknown) => caught);
  assert.instanceOf(error, WHEPSessionError);
  return error;
}

describe("WHEP signaling", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { location: { origin: ORIGIN } });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the offer to the encoded play resource and reads the answer", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        sdpResponse(201, { "Wish-Live-Track-Count": "2" }, "remote-answer"),
      );
    const signal = new AbortController().signal;

    await expect(
      postWhepOffer("alice/id", "local-offer", signal),
    ).resolves.toEqual({
      expectedRemoteTrackCount: 2,
      kind: "accepted",
      sdp: "remote-answer",
      sessionUrl: SESSION_URL,
    });
    // signal は時間切れと合成した別のオブジェクトになるため、下の時間切れと中断のテストで確かめる。
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      new URL(`${ORIGIN}/play/alice%2Fid`),
      expect.objectContaining({
        body: "local-offer",
        headers: {
          Accept: "application/sdp",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
    );
  });

  it.each([
    [
      "an offer",
      15_000,
      () => postWhepOffer("alice", "local-offer", new AbortController().signal),
    ],
    [
      "an answer",
      10_000,
      () =>
        patchWhepAnswer(
          SESSION_URL,
          "local-answer",
          new AbortController().signal,
        ),
    ],
  ] as const)(
    "gives up on %s with no response after %i ms",
    async (_name, timeoutMs, request) => {
      const timeout = new AbortController();
      const timeoutSpy = vi
        .spyOn(AbortSignal, "timeout")
        .mockReturnValue(timeout.signal);
      mockUnresponsiveFetch();

      const pending = request();
      expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(timeoutMs);
      timeout.abort(new DOMException("signal timed out", "TimeoutError"));

      await expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
    },
  );

  it.each([
    [
      "an offer",
      (signal: AbortSignal) => postWhepOffer("alice", "local-offer", signal),
    ],
    [
      "an answer",
      (signal: AbortSignal) =>
        patchWhepAnswer(SESSION_URL, "local-answer", signal),
    ],
  ] as const)(
    "still aborts %s when the caller's signal is aborted",
    async (_name, request) => {
      mockUnresponsiveFetch();
      const caller = new AbortController();

      const pending = request(caller.signal);
      caller.abort();

      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    },
  );

  it("reads a 406 as a counter-offer and allows a missing track count", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(sdpResponse(406));

    await expect(
      postWhepOffer("alice", "local-offer", new AbortController().signal),
    ).resolves.toMatchObject({
      expectedRemoteTrackCount: null,
      kind: "counterOffer",
      sdp: "remote-sdp",
    });
  });

  it.each([
    [404, "Live stream not found: alice", "resource_not_found"],
    [409, "waiting", "resource_unavailable"],
    [403, "forbidden", "client_request_error"],
    [503, "busy", "server_request_error"],
    [200, "ok", "unexpected_response"],
  ] as const)(
    "maps a %i offer response to %s",
    async (status, body, expectedKind) => {
      const error = await postOfferError(new Response(body, { status }));

      expect(error).toMatchObject({
        kind: expectedKind,
        message: body,
        responseText: body,
        retryable: true,
        stage: "post",
      });
    },
  );

  it("falls back to the status in the message when the error body is blank", async () => {
    const error = await postOfferError(new Response("  ", { status: 500 }));

    expect(error.message).toBe("Unexpected WHEP session response: 500");
    expect(error.responseText).toBeUndefined();
  });

  it.each([
    ["a missing location", sdpResponse(201, { Location: "" })],
    ["a zero track count", sdpResponse(201, { "Wish-Live-Track-Count": "0" })],
    [
      "a non-numeric track count",
      sdpResponse(201, { "Wish-Live-Track-Count": "two" }),
    ],
    ["a non-SDP body", sdpResponse(201, { "Content-Type": "text/plain" })],
    ["an empty SDP body", sdpResponse(201, {}, " ")],
  ])(
    "rejects an offer response with %s without retrying",
    async (_case, response) => {
      const error = await postOfferError(response);

      expect(error.retryable).toBe(false);
      expect(error.stage).toBe("post");
    },
  );

  it("patches the answer and rejects anything but 204", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response("bad answer", { status: 400 }));
    const signal = new AbortController().signal;

    await expect(
      patchWhepAnswer(SESSION_URL, "local-answer", signal),
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledWith(
      SESSION_URL,
      expect.objectContaining({
        body: "local-answer",
        headers: {
          Accept: "application/sdp",
          "Content-Type": "application/sdp",
        },
        method: "PATCH",
      }),
    );
    await expect(
      patchWhepAnswer(SESSION_URL, "local-answer", signal),
    ).rejects.toMatchObject({
      kind: "client_request_error",
      message: "bad answer",
      stage: "patch",
    });
  });

  it("does not map a 404 answer response to the end of the live", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("WHEP session not found", { status: 404 }),
    );

    const error = await patchWhepAnswer(
      SESSION_URL,
      "local-answer",
      new AbortController().signal,
    ).catch((patchError: unknown) => patchError);

    assert.instanceOf(error, WHEPSessionError);
    expect(error).toMatchObject({
      kind: "session_not_found",
      retryable: true,
      stage: "patch",
    });
    expect(error.isNotFound()).toBe(false);
  });
});
