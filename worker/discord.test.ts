import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDiscordAuthorizationUrl,
  createOAuthState,
  DiscordApiError,
  DISCORD_STATE_COOKIE_NAME,
  DISCORD_STATE_MAX_AGE_SECONDS,
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
      responseBodyJson: { message: "bad gateway" },
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

  it("creates an opaque 256-bit OAuth state", () => {
    const state = createOAuthState();

    expect(state).toMatch(/^[0-9a-f]{64}$/u);
    expect(createOAuthState()).not.toBe(state);
    expect(DISCORD_STATE_COOKIE_NAME).toBe("discord_oauth_state");
    expect(DISCORD_STATE_MAX_AGE_SECONDS).toBe(600);
  });

  it("exchanges an authorization code and maps the token response", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access",
          expires_in: 3600,
          refresh_token: "refresh",
          scope: "identify guilds.members.read",
          token_type: "Bearer",
        }),
      ),
    );

    const result = await exchangeCodeForToken(
      { DISCORD_CLIENT_ID: "client", DISCORD_CLIENT_SECRET: "secret" },
      "code with spaces",
      "https://example.com/login/callback",
    );

    expect(result._unsafeUnwrap()).toEqual({
      accessToken: "access",
      expiresIn: 3600,
      refreshToken: "refresh",
      scope: "identify guilds.members.read",
      tokenType: "Bearer",
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
      }),
    );
    const request = fetchSpy.mock.calls[0]?.[1];
    expect(request?.body).toBeInstanceOf(URLSearchParams);
    if (!(request?.body instanceof URLSearchParams)) {
      throw new TypeError("Expected an OAuth form body");
    }
    expect([...request.body.entries()]).toEqual([
      ...new URLSearchParams({
        code: "code with spaces",
        grant_type: "authorization_code",
        redirect_uri: "https://example.com/login/callback",
      }).entries(),
    ]);
  });

  it("omits an absent refresh token and rejects invalid token JSON schemas", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          access_token: "access",
          expires_in: 3600,
          scope: "identify",
          token_type: "Bearer",
        }),
      ),
    );
    const result = await exchangeCodeForToken(
      { DISCORD_CLIENT_ID: "client", DISCORD_CLIENT_SECRET: "secret" },
      "code",
      "https://example.com/callback",
    );
    expect(result._unsafeUnwrap().refreshToken).toBeUndefined();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ access_token: "access" })),
    );
    const invalid = await exchangeCodeForToken(
      { DISCORD_CLIENT_ID: "client", DISCORD_CLIENT_SECRET: "secret" },
      "code",
      "https://example.com/callback",
    );
    expect(invalid.isErr()).toBe(true);
    if (invalid.isOk()) throw new Error("Expected a schema error");
    expect(invalid.error.kind).toBe("unexpected_json_response");
    expect(invalid.error.responseBodyJson).toEqual({ access_token: "access" });
  });

  it("retrieves and validates an authorized guild member", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          nick: null,
          user: {
            discriminator: "1234",
            global_name: "Alice Example",
            id: "user-1",
            username: "alice",
          },
        }),
      ),
    );

    const result = await getGuildMember("token", "guild/id");
    expect(result._unsafeUnwrap()).toEqual({
      nick: null,
      user: {
        discriminator: "1234",
        global_name: "Alice Example",
        id: "user-1",
        username: "alice",
      },
    });
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://discord.com/api/v10/users/@me/guilds/guild%2Fid/member",
      expect.objectContaining({
        headers: {
          Accept: "application/json",
          Authorization: "Bearer token",
        },
      }),
    );
  });

  it("accepts nullable Discord profile fields and rejects malformed member JSON", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ user: { id: "user-1", username: "alice" } }),
      ),
    );
    const valid = await getGuildMember("token", "guild");
    expect(valid._unsafeUnwrap().user).toEqual({
      id: "user-1",
      username: "alice",
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ user: { id: "user-1" } })),
    );
    const invalid = await getGuildMember("token", "guild");
    expect(invalid.isErr()).toBe(true);
    if (invalid.isOk()) throw new Error("Expected an invalid member response");
    expect(invalid.error).toMatchObject({
      kind: "unexpected_json_response",
      message: "Discord returned an unexpected JSON response",
    });
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [429, "rate_limited"],
    [500, "http_error"],
  ] as const)("classifies Discord HTTP %i responses", async (status, kind) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "upstream failure" }), {
        status,
        statusText: "Discord Error",
      }),
    );

    const result = await getGuildMember("token", "guild");
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected a Discord API failure");
    expect(result.error).toMatchObject({
      kind,
      responseBodyJson: { message: "upstream failure" },
      statusText: "Discord Error",
    });
  });

  it("preserves messages for each classified Discord HTTP error", () => {
    for (const [status, statusText, kind, message] of [
      [
        401,
        "Unauthorized",
        "unauthorized",
        "Discord request failed: unauthorized",
      ],
      [403, "Forbidden", "forbidden", "Discord request failed: forbidden"],
      [404, "Not Found", "not_found", "Discord request failed: not found"],
      [
        429,
        "Too Many Requests",
        "rate_limited",
        "Discord request failed: rate limited",
      ],
      [503, "Unavailable", "http_error", "Discord request failed"],
    ] as const) {
      expect(
        DiscordApiError.fromHttpFailure(
          status,
          statusText,
          "https://discord.test",
        ),
      ).toMatchObject({ kind, message, statusText });
    }
    expect(
      new DiscordApiError("generic", { endpoint: "", kind: "http_error" }).name,
    ).toBe("DiscordApiError");
  });

  it("releases a Discord token after a successful revoke response", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    const result = await revokeAccessToken(
      { DISCORD_CLIENT_ID: "client", DISCORD_CLIENT_SECRET: "secret" },
      "access-token",
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
        body: new URLSearchParams({
          token: "access-token",
          token_type_hint: "access_token",
        }),
      }),
    );
  });

  it("maps revoke HTTP errors with invalid and empty response bodies", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>denied</html>", {
        status: 403,
        statusText: "Forbidden",
      }),
    );
    const htmlError = await revokeAccessToken(
      { DISCORD_CLIENT_ID: "client", DISCORD_CLIENT_SECRET: "secret" },
      "token",
    );
    expect(htmlError.isErr()).toBe(true);
    if (htmlError.isOk()) throw new Error("Expected revoke to fail");
    expect(htmlError.error).toMatchObject({
      kind: "forbidden",
      responseBodyText: "<html>denied</html>",
      responseBodyJson: undefined,
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("  \n\t  ", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );
    const emptyError = await revokeAccessToken(
      { DISCORD_CLIENT_ID: "client", DISCORD_CLIENT_SECRET: "secret" },
      "token",
    );
    expect(emptyError.isErr()).toBe(true);
    if (emptyError.isOk()) throw new Error("Expected revoke to fail");
    expect(emptyError.error).toMatchObject({
      kind: "http_error",
      responseBodyText: undefined,
      responseBodyJson: undefined,
    });
  });

  it("reports non-JSON successful responses and failed Discord requests", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not JSON"),
    );
    const nonJson = await getGuildMember("token", "guild");
    expect(nonJson.isErr()).toBe(true);
    if (nonJson.isOk()) throw new Error("Expected a JSON error");
    expect(nonJson.error).toMatchObject({
      kind: "non_json_response",
      message: "Discord returned a non-JSON response",
      responseBodyText: "not JSON",
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response(" \n\t "));
    const empty = await getGuildMember("token", "guild");
    expect(empty.isErr()).toBe(true);
    if (empty.isOk()) throw new Error("Expected a JSON error");
    expect(empty.error).toMatchObject({
      kind: "non_json_response",
      responseBodyText: undefined,
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("network down"),
    );
    const failed = await getGuildMember("token", "guild");
    expect(failed.isErr()).toBe(true);
    if (failed.isOk()) throw new Error("Expected a request error");
    expect(failed.error).toMatchObject({
      kind: "request_failed",
      message: "network down",
    });
  });

  it("returns a request error when token revocation cannot reach Discord", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("network down"),
    );

    const result = await revokeAccessToken(
      { DISCORD_CLIENT_ID: "client", DISCORD_CLIENT_SECRET: "secret" },
      "access-token",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected token revocation to fail");
    expect(result.error).toMatchObject({
      endpoint: "https://discord.com/api/v10/oauth2/token/revoke",
      kind: "request_failed",
      message: "network down",
    });
  });

  it("aborts Discord requests at the ten-second deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const pending = getGuildMember("token", "guild");
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected timeout");
    expect(result.error).toMatchObject({
      kind: "request_timeout",
      message: "Discord request timed out",
    });
    vi.useRealTimers();
  });

  it("clears the request timeout after Discord responds", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          user: { id: "user-1", username: "alice" },
        }),
      ),
    );

    const result = await getGuildMember("token", "guild");

    expect(result.isOk()).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  });

  it("prefers structured Discord error details over text and status fallbacks", () => {
    const error = new DiscordApiError("generic", {
      endpoint: "https://discord.com/api",
      kind: "http_error",
      responseBodyJson: {
        error_description: "  OAuth detail  ",
        error: "secondary",
        message: "third",
      },
      responseBodyText: "plain text",
      statusText: "Bad Gateway",
    });
    expect(getDiscordErrorMessage(error)).toBe("  OAuth detail  ");

    expect(
      getDiscordErrorMessage(
        new DiscordApiError("generic", {
          endpoint: "",
          kind: "http_error",
          responseBodyJson: { error_description: "", error: "specific" },
        }),
      ),
    ).toBe("specific");

    expect(
      getDiscordErrorMessage(
        new DiscordApiError("generic", {
          endpoint: "",
          kind: "http_error",
          responseBodyJson: null,
          responseBodyText: "readable response",
        }),
      ),
    ).toBe("readable response");

    expect(
      getDiscordErrorMessage(
        new DiscordApiError("generic", {
          endpoint: "",
          kind: "http_error",
          responseBodyJson: { error: "  ", message: "next detail" },
          responseBodyText: "fallback response",
        }),
      ),
    ).toBe("next detail");

    expect(
      getDiscordErrorMessage(
        new DiscordApiError("generic", {
          endpoint: "",
          kind: "http_error",
          responseBodyJson: {},
          responseBodyText: "fallback response",
        }),
      ),
    ).toBe("fallback response");
  });

  it.each([
    ["<html>proxy error</html>", "Bad Gateway"],
    ["<!doctype html><html>proxy</html>", "Bad Gateway"],
    ["<body>proxy error</body>", "Bad Gateway"],
    ["  <BoDy>proxy error</BoDy>  ", "Bad Gateway"],
    [" <unexpected-proxy-document> ", "Bad Gateway"],
    ["plain upstream message", "plain upstream message"],
    ["", "Bad Gateway"],
  ])("selects a readable message for response body %s", (body, expected) => {
    const error = new DiscordApiError("generic", {
      endpoint: "",
      kind: "http_error",
      responseBodyText: body,
      statusText: "Bad Gateway",
    });
    expect(getDiscordErrorMessage(error)).toBe(expected);
  });

  it("uses mapped HTTP fallback messages when response details are missing", () => {
    for (const [kind, expected] of [
      ["forbidden", "Forbidden"],
      ["not_found", "Not Found"],
      ["rate_limited", "Too Many Requests"],
      ["unauthorized", "Unauthorized"],
    ] as const) {
      expect(
        getDiscordErrorMessage(
          new DiscordApiError("generic", { endpoint: "", kind }),
        ),
      ).toBe(expected);
    }
    expect(
      getDiscordErrorMessage(
        new DiscordApiError("original", { endpoint: "", kind: "http_error" }),
      ),
    ).toBe("original");

    expect(
      getDiscordErrorMessage(
        new DiscordApiError("generic", {
          endpoint: "",
          kind: "forbidden",
          statusText: "  ",
        }),
      ),
    ).toBe("Forbidden");
  });

  it("trims and caps long HTTP response text", async () => {
    const body = `  ${"x ".repeat(150)}  `;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(body, { status: 502, statusText: "Bad Gateway" }),
    );

    const result = await getGuildMember("token", "guild");
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected HTTP error");
    expect(result.error.responseBodyText).toHaveLength(200);
    expect(result.error.responseBodyText).toBe("x ".repeat(100));

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(" \t alpha\n\n beta \r ", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );
    const normalized = await getGuildMember("token", "guild");
    expect(normalized.isErr()).toBe(true);
    if (normalized.isOk()) throw new Error("Expected an HTTP error");
    expect(normalized.error.responseBodyText).toBe("alpha beta");
  });
});
