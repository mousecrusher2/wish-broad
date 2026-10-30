import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnApiError, generateTurnIceServers } from "./turn";

async function expectNoUsableIceServers(
  payload: unknown,
): Promise<TurnApiError> {
  vi.restoreAllMocks();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(payload)),
  );
  const result = await generateTurnIceServers(
    { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
    "viewer",
  );
  expect(result.isErr()).toBe(true);
  if (result.isOk()) throw new Error("Expected no usable ICE server");
  return result.error;
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

    const result = await generateTurnIceServers(
      {
        TURN_KEY_API_TOKEN: "turn-key-api-token",
        TURN_KEY_ID: "turn-key-id",
      },
      "viewer-1",
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([
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

  it("returns an empty_ice_servers error when only port 53 URLs remain", async () => {
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

    const result = await generateTurnIceServers(
      {
        TURN_KEY_API_TOKEN: "turn-key-api-token",
        TURN_KEY_ID: "turn-key-id",
      },
      "viewer-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected TURN credential generation to fail");
    }

    expect(result.error).toBeInstanceOf(TurnApiError);
    expect(result.error.kind).toBe("empty_ice_servers");
  });

  it("returns a timeout result when the TURN request is aborted", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    const result = await generateTurnIceServers(
      {
        TURN_KEY_API_TOKEN: "turn-key-api-token",
        TURN_KEY_ID: "turn-key-id",
      },
      "viewer-1",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected TURN credential generation to fail");
    }

    expect(result.error).toBeInstanceOf(TurnApiError);
    expect(result.error.kind).toBe("request_timeout");
    expect(result.error.endpoint).toBe(
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
    const invalidJson = await generateTurnIceServers(
      { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
      "viewer",
    );
    expect(invalidJson.isErr()).toBe(true);
    if (invalidJson.isOk()) throw new Error("Expected invalid JSON error");
    expect(invalidJson.error.kind).toBe("invalid_response_json");
    expect(invalidJson.error.statusText).toBe("OK");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ iceServers: [{ urls: [1, 2] }] }), {
        statusText: "OK",
      }),
    );
    const invalidSchema = await generateTurnIceServers(
      { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
      "viewer",
    );
    expect(invalidSchema.isErr()).toBe(true);
    if (invalidSchema.isOk())
      throw new Error("Expected schema validation error");
    expect(invalidSchema.error.kind).toBe("invalid_response_schema");
    expect(invalidSchema.error.statusText).toBe("OK");
    expect(invalidSchema.error.responseBody).toMatchObject({
      responseBody: { iceServers: [{ urls: [1, 2] }] },
    });
  });

  it("maps HTTP and network failures and falls back from non-JSON error bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "denied" }), {
        status: 403,
        statusText: "Forbidden",
      }),
    );
    const httpError = await generateTurnIceServers(
      { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
      "viewer",
    );
    expect(httpError.isErr()).toBe(true);
    if (httpError.isOk()) throw new Error("Expected HTTP error");
    expect(httpError.error).toMatchObject({
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
    const nonJsonHttpError = await generateTurnIceServers(
      { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
      "viewer",
    );
    expect(nonJsonHttpError.isErr()).toBe(true);
    if (nonJsonHttpError.isOk()) throw new Error("Expected HTTP failure");
    expect(nonJsonHttpError.error.responseBody).toBeNull();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));
    const requestError = await generateTurnIceServers(
      { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
      "viewer",
    );
    expect(requestError.isErr()).toBe(true);
    if (requestError.isOk()) throw new Error("Expected request failure");
    expect(requestError.error).toMatchObject({
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
    const pending = generateTurnIceServers(
      { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
      "viewer",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected timeout error");
    expect(result.error.kind).toBe("request_timeout");
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
    const result = await generateTurnIceServers(
      { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" },
      "viewer",
    );
    expect(result._unsafeUnwrap()).toEqual([
      { urls: ["turn:relay.example.com:3478"] },
    ]);
  });
});
