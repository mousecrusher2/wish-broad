import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnApiError, generateTurnIceServers } from "./turn";

async function catchTurnError(
  promise: Promise<unknown>,
): Promise<TurnApiError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof TurnApiError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a TurnApiError");
}

async function expectNoUsableIceServers(
  payload: unknown,
): Promise<TurnApiError> {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload)),
  );
  return catchTurnError(
    generateTurnIceServers(
      { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
      "viewer",
    ),
  );
}

describe("worker turn credentials", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("generates ICE servers with a custom identifier and filters port 53", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [
            {
              urls: [
                "stun:stun.cloudflare.com:3478",
                "stun:stun.cloudflare.com:53",
              ],
            },
            {
              credential: "credential",
              urls: [
                "turn:turn.cloudflare.com:3478?transport=udp",
                "turn:turn.cloudflare.com:53?transport=udp",
                "turn:turn.cloudflare.com:80?transport=tcp",
              ],
              username: "username",
            },
          ],
        }),
        {
          status: 201,
        },
      ),
    );

    const iceServers = await generateTurnIceServers(
      {
        TURN_KEY_API_TOKEN: "turn-key-api-token",
        TURN_KEY_ID: "turn-key-id",
      },
      "viewer-1",
    );

    expect(iceServers).toEqual([
      {
        urls: ["stun:stun.cloudflare.com:3478"],
      },
      {
        credential: "credential",
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:80?transport=tcp",
        ],
        username: "username",
      },
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [endpoint, init] = fetchSpy.mock.calls[0] ?? [];
    expect(endpoint).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-id/credentials/generate-ice-servers",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: "Bearer turn-key-api-token",
      "Content-Type": "application/json",
    });
    expect(typeof init?.body).toBe("string");
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected TURN credential request body to be JSON");
    }
    expect(JSON.parse(init.body)).toEqual({
      customIdentifier: "viewer-1",
      ttl: 86_400,
    });
  });

  it.each([
    ["turn:turn.cloudflare.com:53?transport=udp", false],
    ["stun:stun.cloudflare.com:53", false],
    ["turn:turn.cloudflare.com:053?transport=udp", false],
    ["turns:turn.cloudflare.com:5349?transport=tcp", true],
    ["turn:[2001:db8::53]:3478?transport=udp", true],
    ["turn:[2001:db8::53]", true],
  ] as const)("filters %s by port 53 (kept: %s)", async (url, kept) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [{ urls: ["stun:stun.cloudflare.com:3478", url] }],
        }),
        {
          status: 201,
        },
      ),
    );

    const iceServers = await generateTurnIceServers(
      {
        TURN_KEY_API_TOKEN: "turn-key-api-token",
        TURN_KEY_ID: "turn-key-id",
      },
      "viewer-1",
    );

    expect(iceServers).toEqual([
      {
        urls: kept
          ? ["stun:stun.cloudflare.com:3478", url]
          : ["stun:stun.cloudflare.com:3478"],
      },
    ]);
  });

  it("throws an empty_ice_servers error when only port 53 URLs remain", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [
            {
              urls: ["stun:stun.cloudflare.com:53"],
            },
          ],
        }),
        {
          status: 201,
        },
      ),
    );

    const error = await catchTurnError(
      generateTurnIceServers(
        {
          TURN_KEY_API_TOKEN: "turn-key-api-token",
          TURN_KEY_ID: "turn-key-id",
        },
        "viewer-1",
      ),
    );

    expect(error.kind).toBe("empty_ice_servers");
  });

  it("throws a timeout error when the TURN request is aborted", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    const error = await catchTurnError(
      generateTurnIceServers(
        {
          TURN_KEY_API_TOKEN: "turn-key-api-token",
          TURN_KEY_ID: "turn-key-id",
        },
        "viewer-1",
      ),
    );

    expect(error.kind).toBe("request_timeout");
    expect(error.endpoint).toBe(
      "https://rtc.live.cloudflare.com/v1/turn/keys/turn-key-id/credentials/generate-ice-servers",
    );
  });

  it("omits empty server arrays and reports the empty usable-server error", async () => {
    expect((await expectNoUsableIceServers({ iceServers: [] })).kind).toBe(
      "empty_ice_servers",
    );
  });

  it("rejects invalid JSON and schema responses with their response metadata", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not-json", { statusText: "OK" }),
    );
    const invalidJson = await catchTurnError(
      generateTurnIceServers(
        { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
        "viewer",
      ),
    );
    expect(invalidJson.kind).toBe("invalid_response_json");
    expect(invalidJson.statusText).toBe("OK");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ iceServers: [{ urls: [1, 2] }] }), {
        statusText: "OK",
      }),
    );
    const invalidSchema = await catchTurnError(
      generateTurnIceServers(
        { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
        "viewer",
      ),
    );
    expect(invalidSchema.kind).toBe("invalid_response_schema");
    expect(invalidSchema.statusText).toBe("OK");
    expect(invalidSchema.responseBody).toMatchObject({
      responseBody: { iceServers: [{ urls: [1, 2] }] },
    });
  });

  it("maps HTTP and network failures and keeps non-JSON error bodies as text", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "denied" }), {
        status: 403,
        statusText: "Forbidden",
      }),
    );
    const httpError = await catchTurnError(
      generateTurnIceServers(
        { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
        "viewer",
      ),
    );
    expect(httpError).toMatchObject({
      kind: "http_error",
      responseBody: { message: "denied" },
      statusText: "Forbidden",
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("plain error body", {
        status: 500,
        statusText: "Server Error",
      }),
    );
    const nonJsonHttpError = await catchTurnError(
      generateTurnIceServers(
        { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
        "viewer",
      ),
    );
    expect(nonJsonHttpError.responseBody).toBe("plain error body");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const requestError = await catchTurnError(
      generateTurnIceServers(
        { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
        "viewer",
      ),
    );
    expect(requestError).toMatchObject({
      kind: "request_failed",
      responseBody: "offline",
    });
  });

  it("aborts a request when the five-second timeout expires", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const pending = catchTurnError(
      generateTurnIceServers(
        { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
        "viewer",
      ),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await pending;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(error.kind).toBe("request_timeout");
    vi.useRealTimers();
  });

  it("normalizes a single URL string to an array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [{ urls: "turn:relay.example.com:3478" }],
        }),
      ),
    );
    const iceServers = await generateTurnIceServers(
      { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
      "viewer",
    );
    expect(iceServers).toEqual([{ urls: ["turn:relay.example.com:3478"] }]);
  });
});
