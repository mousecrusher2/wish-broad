import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDiscordAuthorizationUrl,
  createOAuthState,
  DiscordApiError,
  exchangeCodeForToken,
  getDiscordErrorMessage,
  getGuildMember,
  revokeAccessToken,
} from "./discord";

describe("worker discord helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a Discord authorization URL with the configured scopes", () => {
    const url = new URL(
      buildDiscordAuthorizationUrl(
        {
          DISCORD_CLIENT_ID: "client-id",
        },
        "https://example.com/login",
        "state-123",
      ),
    );

    expect(url.origin + url.pathname).toBe(
      "https://discord.com/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.com/login",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("identify guilds.members.read");
    expect(url.searchParams.get("state")).toBe("state-123");
  });

  it("returns an error result when token exchange returns a non-JSON error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>rate limited</html>", {
        headers: {
          "Content-Type": "text/html",
        },
        status: 429,
        statusText: "Too Many Requests",
      }),
    );

    const result = await exchangeCodeForToken(
      {
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
      },
      "auth-code",
      "https://example.com/login",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected token exchange to fail");
    }

    expect(result.error).toMatchObject({
      endpoint: "https://discord.com/api/v10/oauth2/token",
      kind: "rate_limited",
      responseBodyText: "<html>rate limited</html>",
      statusText: "Too Many Requests",
    });
  });

  it("returns an error result when token revocation fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "bad gateway" }), {
        headers: {
          "Content-Type": "application/json",
        },
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    const result = await revokeAccessToken(
      {
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
      },
      "discord-access-token",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected token revocation to fail");
    }

    expect(result.error).toMatchObject({
      endpoint: "https://discord.com/api/v10/oauth2/token/revoke",
      kind: "http_error",
      statusText: "Bad Gateway",
    });
  });

  it("returns a timeout error result when the Discord request is aborted", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    const result = await exchangeCodeForToken(
      {
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
      },
      "auth-code",
      "https://example.com/login",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected token exchange to fail");
    }

    expect(result.error).toMatchObject({
      endpoint: "https://discord.com/api/v10/oauth2/token",
      kind: "request_timeout",
    });
  });

  it("generates a 32-byte unpredictable OAuth state with leading zeroes", () => {
    const random = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation((bytes) => {
        const output = bytes as Uint8Array;
        expect(output).toHaveLength(32);
        for (let index = 0; index < output.length; index += 1)
          output[index] = index;
        return bytes;
      });
    expect(createOAuthState()).toBe(
      Array.from({ length: 32 }, (_, index) =>
        index.toString(16).padStart(2, "0"),
      ).join(""),
    );
    expect(random).toHaveBeenCalledOnce();
  });

  it("exchanges a code for a validated OAuth token", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access",
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "refresh",
          scope: "identify guilds.members.read",
        }),
        { status: 200 },
      ),
    );
    const result = await exchangeCodeForToken(
      { DISCORD_CLIENT_ID: "client", DISCORD_CLIENT_SECRET: "secret" },
      "code",
      "https://wish.test/callback",
    );
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw result.error;
    expect(result.value).toEqual({
      accessToken: "access",
      tokenType: "Bearer",
      expiresIn: 3600,
      refreshToken: "refresh",
      scope: "identify guilds.members.read",
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://discord.com/api/v10/oauth2/token",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${btoa("client:secret")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        signal: expect.any(AbortSignal),
      }),
    );
    const body = fetchSpy.mock.calls[0]?.[1]?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(String(body)).toBe(
      "code=code&grant_type=authorization_code&redirect_uri=https%3A%2F%2Fwish.test%2Fcallback",
    );
  });

  it("fetches a guild member with an encoded guild ID and bearer auth", async () => {
    const member = {
      user: {
        id: "u",
        username: "Alice",
        discriminator: null,
        global_name: "Alice",
      },
      nick: "Streamer",
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(member)));
    const result = await getGuildMember("access", "guild/one");
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw result.error;
    expect(result.value).toEqual(member);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me/guilds/guild%2Fone/member",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer access" },
      }),
    );
  });

  it("rejects malformed Discord JSON and non-JSON success responses", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("<html>wrong</html>"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { id: 1 } })))
      .mockResolvedValueOnce(new Response(""));
    const nonJson = await getGuildMember("access", "guild");
    expect(nonJson).toMatchObject({
      error: expect.objectContaining({
        kind: "non_json_response",
        responseBodyText: "<html>wrong</html>",
      }),
    });
    const invalid = await getGuildMember("access", "guild");
    expect(invalid).toMatchObject({
      error: expect.objectContaining({ kind: "unexpected_json_response" }),
    });
    const empty = await getGuildMember("access", "guild");
    expect(empty).toMatchObject({
      error: expect.objectContaining({ kind: "non_json_response" }),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it("revokes the access token using the OAuth revoke endpoint", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const result = await revokeAccessToken(
      { DISCORD_CLIENT_ID: "client", DISCORD_CLIENT_SECRET: "secret" },
      "access",
    );
    expect(result.isOk()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://discord.com/api/v10/oauth2/token/revoke",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Basic ${btoa("client:secret")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }),
    );
    expect(String(fetchSpy.mock.calls[0]?.[1]?.body)).toBe(
      "token=access&token_type_hint=access_token",
    );
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
    [502, "http_error"],
  ] as const)("classifies Discord HTTP %i", async (status, kind) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "problem" }), {
        status,
        statusText: "Error",
      }),
    );
    const result = await getGuildMember("access", "guild");
    expect(result).toMatchObject({
      error: expect.objectContaining({
        kind,
        statusText: "Error",
        responseBodyJson: { message: "problem" },
      }),
    });
  });

  it("chooses safe Discord error details in priority order", () => {
    const create = (options: {
      responseBodyJson?: unknown;
      responseBodyText?: string;
      statusText?: string;
      kind?: "rate_limited" | "http_error";
    }) =>
      new DiscordApiError("fallback", {
        endpoint: "url",
        kind: options.kind ?? "http_error",
        ...options,
      });
    expect(
      getDiscordErrorMessage(
        create({
          responseBodyJson: {
            error_description: "explanation",
            message: "other",
          },
        }),
      ),
    ).toBe("explanation");
    expect(
      getDiscordErrorMessage(
        create({ responseBodyJson: { error: "error code", message: "other" } }),
      ),
    ).toBe("error code");
    expect(
      getDiscordErrorMessage(
        create({ responseBodyJson: { message: "message" } }),
      ),
    ).toBe("message");
    expect(
      getDiscordErrorMessage(
        create({
          responseBodyJson: { error: "   " },
          responseBodyText: "plain text",
        }),
      ),
    ).toBe("plain text");
    expect(
      getDiscordErrorMessage(
        create({
          responseBodyText: "<!doctype html><html>bad</html>",
          statusText: "Bad Request",
        }),
      ),
    ).toBe("Bad Request");
    expect(
      getDiscordErrorMessage(
        create({ responseBodyText: "<body>bad</body>", kind: "rate_limited" }),
      ),
    ).toBe("Too Many Requests");
    expect(
      getDiscordErrorMessage(create({ responseBodyJson: { message: 17 } })),
    ).toBe("fallback");
  });

  it.each([
    ["<html>unsafe</html>", "Forbidden"],
    [" <!DOCTYPE HTML>unsafe", "Forbidden"],
    ["<body>unsafe</body>", "Forbidden"],
    ["<script>unsafe</script>", "Forbidden"],
    ["plain failure", "plain failure"],
  ])("uses safe text for Discord error body %s", (body, message) => {
    const error = new DiscordApiError("fallback", {
      endpoint: "url",
      kind: "forbidden",
      responseBodyText: body,
    });
    expect(getDiscordErrorMessage(error)).toBe(message);
  });

  it.each([
    ["unauthorized", "Unauthorized"],
    ["forbidden", "Forbidden"],
    ["not_found", "Not Found"],
    ["rate_limited", "Too Many Requests"],
    ["http_error", "fallback"],
  ] as const)(
    "uses the %s fallback when upstream sends no useful text",
    (kind, message) => {
      const error = new DiscordApiError("fallback", {
        endpoint: "url",
        kind,
        responseBodyText: "<html>unsafe",
        statusText: "   ",
      });
      expect(getDiscordErrorMessage(error)).toBe(message);
    },
  );

  it("ignores inherited and accessor properties in upstream JSON errors", () => {
    const json = Object.create({ message: "prototype value" });
    Object.defineProperty(json, "error_description", {
      get: () => {
        throw new Error("accessor evaluated");
      },
      enumerable: true,
    });
    const error = new DiscordApiError("fallback", {
      endpoint: "url",
      kind: "http_error",
      responseBodyJson: json,
      responseBodyText: "safe body",
    });
    expect(getDiscordErrorMessage(error)).toBe("safe body");
  });

  it("normalizes and truncates the Discord error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(` \n${"x".repeat(220)} \t`, {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );
    const result = await getGuildMember("access", "guild");
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "http_error",
      responseBodyText: "x".repeat(200),
      statusText: "Bad Gateway",
    });
  });

  it("preserves parsed JSON for an unsuccessful token revocation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(' { "message": "denied" } ', {
        status: 403,
        statusText: "Forbidden",
      }),
    );
    const result = await revokeAccessToken(
      { DISCORD_CLIENT_ID: "client", DISCORD_CLIENT_SECRET: "secret" },
      "token",
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "forbidden",
      responseBodyJson: { message: "denied" },
      responseBodyText: '{ "message": "denied" }',
      statusText: "Forbidden",
    });
  });
});
