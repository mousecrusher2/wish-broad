import { env } from "cloudflare:workers";
import { verify } from "hono/jwt";
import { assert, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DiscordApiError,
  type DiscordGuildMember,
  type DiscordOAuthToken,
} from "../clients/discord-oauth";
import { fetchApp, getStoredUsers, setUpWorkerTest } from "../testing/app";
import type { Bindings } from "../types";

// Discord OAuth のクライアントは ../clients/discord-oauth.test.ts で HTTP レベルまで検証して
// いるため、ここではルートとの境界で差し替える。
const discordMocks = vi.hoisted(() => ({
  buildDiscordAuthorizationUrl:
    vi.fn<
      (
        env: Pick<Bindings, "DISCORD_CLIENT_ID">,
        redirectUri: string,
        state: string,
      ) => string
    >(),
  createOAuthState: vi.fn<() => string>(),
  exchangeCodeForToken:
    vi.fn<
      (
        env: Pick<Bindings, "DISCORD_CLIENT_ID" | "DISCORD_CLIENT_SECRET">,
        code: string,
        redirectUri: string,
      ) => Promise<unknown>
    >(),
  getGuildMember:
    vi.fn<(accessToken: string, guildId: string) => Promise<unknown>>(),
  revokeAccessToken:
    vi.fn<
      (
        env: Pick<Bindings, "DISCORD_CLIENT_ID" | "DISCORD_CLIENT_SECRET">,
        accessToken: string,
      ) => Promise<unknown>
    >(),
}));

vi.mock("../clients/discord-oauth", async () => ({
  ...(await vi.importActual<typeof import("../clients/discord-oauth")>(
    "../clients/discord-oauth",
  )),
  ...discordMocks,
}));

async function requestLoginCallback(
  query: Record<string, string>,
  stateCookie: string | null = "oauth-state",
  bindings: Bindings = env,
): Promise<Response> {
  const headers = new Headers();
  if (stateCookie !== null) {
    headers.set("Cookie", `discord_oauth_state=${stateCookie}`);
  }
  const url = new URL("http://localhost/login/callback");
  url.search = new URLSearchParams(query).toString();
  return fetchApp(new Request(url, { headers }), undefined, bindings);
}

function getSetCookieValue(response: Response, name: string): string {
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie
    ?.split(/, (?=[^;,]+=)/u)
    .find((value) => value.startsWith(`${name}=`));
  assert.isDefined(cookie, `Missing ${name} cookie`);
  return cookie;
}

describe("auth routes", () => {
  const spies = setUpWorkerTest();

  beforeEach(() => {
    for (const mock of Object.values(discordMocks)) {
      mock.mockReset();
    }

    discordMocks.buildDiscordAuthorizationUrl.mockImplementation(
      (_env, redirectUri, state) =>
        `https://discord.com/oauth2/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    );
    discordMocks.createOAuthState.mockReturnValue("oauth-state");
    discordMocks.exchangeCodeForToken.mockResolvedValue({
      accessToken: "discord-access-token",
      expiresIn: 3600,
      scope: "guilds.members.read",
      tokenType: "Bearer",
    } satisfies DiscordOAuthToken);
    discordMocks.getGuildMember.mockResolvedValue({
      nick: null,
      user: {
        discriminator: null,
        global_name: "Alice",
        id: "user-1",
        username: "alice",
      },
    } satisfies DiscordGuildMember);
    discordMocks.revokeAccessToken.mockResolvedValue(undefined);
  });

  it("redirects to Discord when login starts", async () => {
    const response = await fetchApp(
      new Request("http://localhost/login?ignored=secret"),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://discord.com/oauth2/authorize?redirect_uri=http%3A%2F%2Flocalhost%2Flogin%2Fcallback&state=oauth-state",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "discord_oauth_state=oauth-state",
    );
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=600");
    expect(response.headers.get("set-cookie")).toContain("Path=/login");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("clears the auth cookie when logging out", async () => {
    const response = await fetchApp(
      new Request("http://localhost/logout", {
        headers: { Cookie: "authtoken=existing", Origin: "http://localhost" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain("authtoken=;");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("rejects Discord login when the OAuth state is invalid", async () => {
    const response = await fetchApp(
      new Request(
        "http://localhost/login/callback?code=auth-code&state=wrong-state",
        {
          headers: {
            Cookie: "discord_oauth_state=oauth-state",
          },
        },
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Invalid OAuth state");
    expect(discordMocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "auth-code", state: "oauth-state" }, null],
    [{ code: "auth-code" }, "oauth-state"],
    [{ code: "auth-code", state: "wrong-state" }, "oauth-state"],
  ] as const)(
    "rejects a callback with missing or mismatched state",
    async (query, stateCookie) => {
      const response = await requestLoginCallback(query, stateCookie);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("Invalid OAuth state");
      expect(discordMocks.exchangeCodeForToken).not.toHaveBeenCalled();
      expect(response.headers.get("set-cookie")).toContain(
        "discord_oauth_state=;",
      );
      expect(response.headers.get("set-cookie")).toContain("Path=/login");
      expect(response.headers.get("set-cookie")).toContain("SameSite=Lax");
      expect(response.headers.get("set-cookie")).toContain("Secure");
    },
  );

  it.each([
    [
      "access_denied",
      "user cancelled",
      "Discord authorization failed: user cancelled",
    ],
    ["access_denied", "", "Discord authorization failed: "],
    ["access_denied", undefined, "Discord authorization failed: access_denied"],
  ] as const)(
    "returns the Discord authorization error description when provided",
    async (error, description, expectedBody) => {
      const query: Record<string, string> = {
        error,
        state: "oauth-state",
      };
      if (description !== undefined) {
        query["error_description"] = description;
      }
      const response = await requestLoginCallback(query);

      expect(response.status).toBe(401);
      expect(await response.text()).toBe(expectedBody);
      expect(discordMocks.exchangeCodeForToken).not.toHaveBeenCalled();
    },
  );

  it("requires a code after validating OAuth state", async () => {
    const response = await requestLoginCallback({
      state: "oauth-state",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Authorization code is required");
    expect(discordMocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("maps OAuth token exchange errors to a logged 502 response", async () => {
    discordMocks.exchangeCodeForToken.mockRejectedValue(
      new DiscordApiError("token exchange failed", {
        endpoint: "https://discord.com/api/oauth2/token",
        kind: "http_error",
        statusText: "Bad Gateway",
      }),
    );

    const response = await requestLoginCallback({
      code: "auth-code",
      state: "oauth-state",
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Discord login failed: Bad Gateway");
    expect(spies.consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://discord.com/api/oauth2/token",
        errorMessage: "token exchange failed",
        errorName: "DiscordApiError",
        event: "discord.login_token_exchange_failed",
        statusText: "Bad Gateway",
      }),
    );
    expect(discordMocks.getGuildMember).not.toHaveBeenCalled();
    expect(discordMocks.revokeAccessToken).not.toHaveBeenCalled();
  });

  it("issues an auth cookie after a successful Discord login", async () => {
    const now = Date.UTC(2025, 0, 1);
    vi.setSystemTime(now);

    const response = await fetchApp(
      new Request(
        "http://localhost/login/callback?code=auth-code&state=oauth-state",
        {
          headers: {
            Cookie: "discord_oauth_state=oauth-state",
          },
        },
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(discordMocks.exchangeCodeForToken).toHaveBeenCalledWith(
      env,
      "auth-code",
      "http://localhost/login/callback",
    );
    expect(discordMocks.getGuildMember).toHaveBeenCalledWith(
      "discord-access-token",
      env.AUTHORIZED_GUILD_ID,
    );
    await expect(getStoredUsers()).resolves.toEqual([
      { display_name: "Alice", user_id: "user-1" },
    ]);
    expect(discordMocks.revokeAccessToken).toHaveBeenCalledWith(
      env,
      "discord-access-token",
    );
    expect(response.headers.get("set-cookie")).toContain("authtoken=");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(response.headers.get("set-cookie")).toContain("Secure");
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const authCookie = getSetCookieValue(response, "authtoken");
    const token = authCookie.slice("authtoken=".length).split(";", 1)[0];
    assert(token, "Login response did not contain an auth token");
    const payload = await verify(token, env.JWT_SECRET, "HS256");
    expect(payload).toMatchObject({ displayName: "Alice", userId: "user-1" });
    expect(payload.iat).toBe(now / 1000);
    expect(payload.exp).toBe(now / 1000 + 86_400);
    expect(authCookie).toContain(
      `Expires=${new Date(now + 86_400_000).toUTCString()}`,
    );
    expect(spies.consoleWarn).not.toHaveBeenCalled();
  });

  it("omits Secure cookies outside production", async () => {
    const response = await requestLoginCallback(
      {
        code: "auth-code",
        state: "oauth-state",
      },
      "oauth-state",
      { ...env, ENVIRONMENT: "development" },
    );

    expect(response.status).toBe(302);
    expect(getSetCookieValue(response, "authtoken")).not.toContain("Secure");
    expect(response.headers.get("set-cookie")).not.toContain("Secure");
  });

  it.each([
    ["nickname", "global name", "username", "nickname"],
    [null, null, "username", "username"],
  ] as const)(
    "chooses the best available Discord display name",
    async (nick, globalName, username, displayName) => {
      discordMocks.getGuildMember.mockResolvedValue({
        nick,
        user: {
          discriminator: null,
          global_name: globalName,
          id: "user-1",
          username,
        },
      } satisfies DiscordGuildMember);

      const response = await requestLoginCallback({
        code: "auth-code",
        state: "oauth-state",
      });

      expect(response.status).toBe(302);
      await expect(getStoredUsers()).resolves.toEqual([
        { display_name: displayName, user_id: "user-1" },
      ]);
    },
  );

  it("keeps successful login when Discord token revocation fails", async () => {
    discordMocks.revokeAccessToken.mockRejectedValue(
      new DiscordApiError("revocation failed", {
        endpoint: "https://discord.com/api/oauth2/token/revoke",
        kind: "http_error",
        statusText: "Bad Gateway",
      }),
    );

    const response = await requestLoginCallback({
      code: "auth-code",
      state: "oauth-state",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("authtoken=");
    expect(spies.consoleWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://discord.com/api/oauth2/token/revoke",
        errorMessage: "revocation failed",
        errorName: "DiscordApiError",
        event: "discord.oauth_revoke_failed",
        statusText: "Bad Gateway",
      }),
    );
  });

  it("rejects Discord login when the user is not in the authorized guild", async () => {
    discordMocks.getGuildMember.mockRejectedValue(
      new DiscordApiError("Discord request failed: not found", {
        endpoint: `https://discord.com/api/v10/users/@me/guilds/${env.AUTHORIZED_GUILD_ID}/member`,
        kind: "not_found",
        statusText: "Not Found",
      }),
    );

    const response = await requestLoginCallback({
      code: "auth-code",
      state: "oauth-state",
    });

    expect(response.status).toBe(401);
    expect(await response.text()).toBe(
      "Unauthorized: You are not a member of the authorized Discord server",
    );
    expect(discordMocks.revokeAccessToken).toHaveBeenCalledWith(
      env,
      "discord-access-token",
    );
    await expect(getStoredUsers()).resolves.toEqual([]);
    expect(spies.consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "Discord request failed: not found",
        event: "discord.login_member_check_failed",
        guildId: env.AUTHORIZED_GUILD_ID,
      }),
    );
  });

  it.each([
    ["unauthorized", true, 401],
    ["forbidden", true, 401],
    ["not_found", false, 502],
    ["forbidden", false, 502],
    ["http_error", true, 502],
  ] as const)(
    "classifies Discord member lookup %s with matchingEndpoint=%s",
    async (kind, matchingEndpoint, expectedStatus) => {
      const endpoint = matchingEndpoint
        ? `https://discord.com/api/v10/users/@me/guilds/${env.AUTHORIZED_GUILD_ID}/member`
        : "https://discord.com/api/v10/users/@me/guilds/another-guild/member";
      discordMocks.getGuildMember.mockRejectedValue(
        new DiscordApiError("member lookup failed", {
          endpoint,
          kind,
          statusText: "Forbidden",
        }),
      );

      const response = await requestLoginCallback({
        code: "auth-code",
        state: "oauth-state",
      });

      expect(response.status).toBe(expectedStatus);
      expect(await response.text()).toBe(
        expectedStatus === 401
          ? "Unauthorized: You are not a member of the authorized Discord server"
          : "Discord login failed: Forbidden",
      );
      expect(discordMocks.revokeAccessToken).toHaveBeenCalledWith(
        env,
        "discord-access-token",
      );
      await expect(getStoredUsers()).resolves.toEqual([]);
    },
  );
});
