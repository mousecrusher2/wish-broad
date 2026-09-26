import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnApiError, generateTurnIceServers } from "./turn";

describe("worker turn credentials", () => {
  afterEach(() => {
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

  const env = { TURN_KEY_API_TOKEN: "token", TURN_KEY_ID: "key" };

  it.each([
    ["turn:host:53", false],
    ["turn:host:53?transport=tcp", false],
    ["turn:[2001:db8::1]:53?transport=udp", false],
    ["turn:[2001:db8::1]:3478?transport=udp", true],
    ["turn:[2001:db8::1]", true],
    ["turn:[2001:db8::1", true],
    ["turn:host:3478", true],
    ["turn:host", true],
    ["turn:", true],
    ["host:53", true],
    ["no-colon", true],
  ] as const)(
    "filters ICE URL %s according to its port",
    async (url, allowed) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        Response.json({ iceServers: [{ urls: [url, "stun:backup:3478"] }] }),
      );
      const result = await generateTurnIceServers(env, "user");
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([
        { urls: allowed ? [url, "stun:backup:3478"] : ["stun:backup:3478"] },
      ]);
    },
  );

  it("accepts a string URL and removes empty optional credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        iceServers: [{ urls: "stun:host:3478", username: "", credential: "" }],
      }),
    );
    const result = await generateTurnIceServers(env, "user");
    expect(result._unsafeUnwrap()).toEqual([{ urls: ["stun:host:3478"] }]);
  });

  it.each([
    [new Error("offline"), "request_failed", "offline"],
    ["offline", "request_failed", "offline"],
    [new DOMException("aborted", "AbortError"), "request_timeout", "aborted"],
  ])("classifies fetch failure %s", async (failure, kind, body) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);
    const result = await generateTurnIceServers(env, "user");
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind,
      message:
        kind === "request_timeout"
          ? "TURN credential request timed out"
          : "TURN credential request failed",
      responseBody: body,
    });
  });

  it.each([
    [
      new Response('{"error":"denied"}', {
        status: 403,
        statusText: "Forbidden",
      }),
      "http_error",
      { error: "denied" },
    ],
    [
      new Response("plain error", { status: 502, statusText: "Bad Gateway" }),
      "http_error",
      "plain error",
    ],
    [
      new Response("invalid", { status: 200, statusText: "OK" }),
      "invalid_response_json",
      undefined,
    ],
    [
      Response.json({ iceServers: "invalid" }),
      "invalid_response_schema",
      undefined,
    ],
    [
      Response.json({ iceServers: [] }),
      "empty_ice_servers",
      { iceServers: [] },
    ],
  ])(
    "classifies invalid TURN responses as %s",
    async (response, kind, body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
      const result = await generateTurnIceServers(env, "user");
      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error).toBeInstanceOf(TurnApiError);
      expect(error.kind).toBe(kind);
      expect(error.endpoint).toContain(
        "/v1/turn/keys/key/credentials/generate-ice-servers",
      );
      expect(error.statusText).toBe(
        kind === "empty_ice_servers" ? undefined : response.statusText,
      );
      if (body !== undefined) expect(error.responseBody).toEqual(body);
    },
  );
});
