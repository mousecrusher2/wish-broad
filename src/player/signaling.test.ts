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
  deleteWhepSession,
  patchWhepAnswer,
  postWhepOffer,
  WHEPSessionError,
} from "./signaling";

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
    expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(
      new URL(`${ORIGIN}/play/alice%2Fid`),
      {
        body: "local-offer",
        headers: {
          Accept: "application/sdp",
          "Content-Type": "application/sdp",
        },
        method: "POST",
        signal,
      },
    );
  });

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
    expect(fetchSpy).toHaveBeenCalledWith(SESSION_URL, {
      body: "local-answer",
      headers: {
        Accept: "application/sdp",
        "Content-Type": "application/sdp",
      },
      method: "PATCH",
      signal,
    });
    await expect(
      patchWhepAnswer(SESSION_URL, "local-answer", signal),
    ).rejects.toMatchObject({
      kind: "client_request_error",
      message: "bad answer",
      stage: "patch",
    });
  });

  it("only warns when the session DELETE fails", async () => {
    const networkError = new TypeError("network down");
    vi.spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(new Response("", { status: 502 }));

    await expect(deleteWhepSession(SESSION_URL)).resolves.toBeUndefined();
    await expect(deleteWhepSession(SESSION_URL)).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenNthCalledWith(
      1,
      "Failed to close WHEP session:",
      networkError,
    );
    expect(console.warn).toHaveBeenNthCalledWith(
      2,
      "Failed to close WHEP session:",
      expect.objectContaining({
        kind: "server_request_error",
        message: "Unexpected WHEP delete response: 502",
        stage: "delete",
      }),
    );
  });
});
