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
      throw new Error("Expected TURN credential request body to be JSON");
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
});
