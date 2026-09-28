import { sign, verify } from "hono/jwt";
import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import type { Bindings } from "./types";
import type { DiscordGuildMember, DiscordOAuthToken } from "./discord";
import type { StoredTrack } from "./sfu";
import { LiveNotFoundError, SfuApiError } from "./sfu";
import { hashTokenWithPepper } from "./token-hash";

const dbMocks = vi.hoisted(() => ({
  deleteLiveForSession: vi.fn<() => Promise<boolean>>(),
  getAllLives: vi.fn<() => Promise<unknown[]>>(),
  getLiveTokenHash: vi.fn<() => Promise<string | null>>(),
  getLive: vi.fn<
    () => Promise<{
      notificationMessageId?: bigint | null | undefined;
      userId: string;
      sessionId: string;
      tracks: StoredTrack[];
    } | null>
  >(),
  hasLiveToken: vi.fn<() => Promise<boolean>>(),
  insertLive: vi.fn<() => Promise<void>>(),
  setLiveNotificationMessageId: vi.fn<() => Promise<boolean>>(),
  setLiveToken: vi.fn<() => Promise<void>>(),
  setUser: vi.fn<() => Promise<void>>(),
}));

const callsMocks = vi.hoisted(() => {
  return {
    closeTracks: vi.fn<() => Promise<unknown>>(),
    isSessionActive: vi.fn<() => Promise<unknown>>(),
    renegotiateSession: vi.fn<() => Promise<unknown>>(),
    startIngest: vi.fn<() => Promise<unknown>>(),
    startPlay: vi.fn<() => Promise<unknown>>(),
  };
});

const notificationsMocks = vi.hoisted(() => ({
  deleteLiveStartedNotification: vi.fn<() => Promise<unknown>>(),
  sendLiveStartedNotification: vi.fn<() => Promise<unknown>>(),
}));

const turnMocks = vi.hoisted(() => ({
  generateTurnIceServers: vi.fn<() => Promise<unknown>>(),
}));

const discordMocks = vi.hoisted(() => {
  class MockDiscordApiError extends Error {
    readonly endpoint: string;
    readonly kind:
      | "request_failed"
      | "unauthorized"
      | "forbidden"
      | "not_found"
      | "rate_limited"
      | "http_error"
      | "non_json_response"
      | "unexpected_json_response";
    readonly responseBodyJson: unknown;
    readonly responseBodyText: string | undefined;
    readonly statusText: string | undefined;

    constructor(
      message: string,
      options: {
        endpoint: string;
        kind:
          | "request_failed"
          | "unauthorized"
          | "forbidden"
          | "not_found"
          | "rate_limited"
          | "http_error"
          | "non_json_response"
          | "unexpected_json_response";
        statusText?: string;
        responseBodyText?: string;
        responseBodyJson?: unknown;
      },
    ) {
      super(message);
      this.name = "DiscordApiError";
      ({
        endpoint: this.endpoint,
        kind: this.kind,
        statusText: this.statusText,
        responseBodyText: this.responseBodyText,
        responseBodyJson: this.responseBodyJson,
      } = options);
    }
  }

  return {
    DiscordApiError: MockDiscordApiError,
    DISCORD_STATE_COOKIE_NAME: "discord_oauth_state",
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
    getDiscordErrorMessage: vi.fn<(error: unknown) => string>(),
    getGuildMember:
      vi.fn<(accessToken: string, guildId: string) => Promise<unknown>>(),
    revokeAccessToken:
      vi.fn<
        (
          env: Pick<Bindings, "DISCORD_CLIENT_ID" | "DISCORD_CLIENT_SECRET">,
          accessToken: string,
        ) => Promise<unknown>
      >(),
  };
});

vi.mock("./database", () => dbMocks);
vi.mock("./sfu", async () => {
  const actual = await vi.importActual<typeof import("./sfu")>("./sfu");
  return {
    ...actual,
    closeTracks: callsMocks.closeTracks,
    isSessionActive: callsMocks.isSessionActive,
    renegotiateSession: callsMocks.renegotiateSession,
    startIngest: callsMocks.startIngest,
    startPlay: callsMocks.startPlay,
  };
});
vi.mock("./discord", () => ({
  DISCORD_STATE_COOKIE_NAME: discordMocks.DISCORD_STATE_COOKIE_NAME,
  DISCORD_STATE_MAX_AGE_SECONDS: 600,
  DiscordApiError: discordMocks.DiscordApiError,
  buildDiscordAuthorizationUrl: discordMocks.buildDiscordAuthorizationUrl,
  createOAuthState: discordMocks.createOAuthState,
  exchangeCodeForToken: discordMocks.exchangeCodeForToken,
  getDiscordErrorMessage: discordMocks.getDiscordErrorMessage,
  getGuildMember: discordMocks.getGuildMember,
  revokeAccessToken: discordMocks.revokeAccessToken,
}));
vi.mock("./notifications", () => ({
  deleteLiveStartedNotification:
    notificationsMocks.deleteLiveStartedNotification,
  sendLiveStartedNotification: notificationsMocks.sendLiveStartedNotification,
}));
vi.mock("./turn", () => ({
  generateTurnIceServers: turnMocks.generateTurnIceServers,
}));

import app from "./index";

function createUnusedD1PreparedStatement(): D1PreparedStatement {
  return {
    bind() {
      throw new Error("Unexpected D1 access in tests");
    },
    first() {
      throw new Error("Unexpected D1 access in tests");
    },
    run() {
      throw new Error("Unexpected D1 access in tests");
    },
    all() {
      throw new Error("Unexpected D1 access in tests");
    },
    raw() {
      throw new Error("Unexpected D1 access in tests");
    },
  };
}

function createUnusedD1DatabaseSession(): D1DatabaseSession {
  return {
    prepare() {
      throw new Error("Unexpected D1 session access in tests");
    },
    batch() {
      throw new Error("Unexpected D1 session access in tests");
    },
    getBookmark() {
      throw new Error("Unexpected D1 session access in tests");
    },
  };
}

function createUnusedD1Database(): D1Database {
  return {
    prepare() {
      return createUnusedD1PreparedStatement();
    },
    batch() {
      throw new Error("Unexpected D1 access in tests");
    },
    exec() {
      throw new Error("Unexpected D1 access in tests");
    },
    withSession() {
      return createUnusedD1DatabaseSession();
    },
    // oxlint-disable-next-line typescript/no-deprecated -- The deprecated method remains required by the D1Database test double type.
    ["dump"]() {
      throw new Error("Unexpected D1 access in tests");
    },
  };
}

class UnusedTracingSpan {
  get isTraced(): boolean {
    return false;
  }

  setAttribute(
    _key: string,
    _value: boolean | number | string,
  ): UnusedTracingSpan {
    return this;
  }

  setAttributes(
    _attributes: Record<string, boolean | number | string | undefined>,
  ): UnusedTracingSpan {
    return this;
  }

  recordException(
    _exception:
      | string
      | {
          code: string | number;
          name?: string;
          message?: string;
          stack?: string;
        }
      | {
          code?: string | number;
          name: string;
          message?: string;
          stack?: string;
        }
      | {
          code?: string | number;
          name?: string;
          message: string;
          stack?: string;
        },
  ): void {}

  updateName(_name: string): UnusedTracingSpan {
    return this;
  }

  setStatus(_status: TracingSpanStatus): UnusedTracingSpan {
    return this;
  }

  end(): void {}
}

function failUnusedTracingAccess(): never {
  throw new Error("Unexpected tracing access in tests");
}

function createUnusedTracing(): Tracing {
  return {
    enterSpan: failUnusedTracingAccess,
    getActiveSpan: failUnusedTracingAccess,
    startActiveSpan: failUnusedTracingAccess,
    startSpan: failUnusedTracingAccess,
    Span: UnusedTracingSpan,
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    get exports(): never {
      throw new Error("Unexpected execution context exports access in tests");
    },
    passThroughOnException() {},
    waitUntil(promise: Promise<unknown>) {
      void promise;
    },
    abort() {
      throw new Error("Unexpected execution context abort in tests");
    },
    props: undefined,
    tracing: createUnusedTracing(),
  };
}

function createObservedExecutionContext(): {
  context: ExecutionContext;
  waitUntilPromises: Promise<unknown>[];
} {
  const waitUntilPromises: Promise<unknown>[] = [];
  return {
    context: {
      get exports(): never {
        throw new Error("Unexpected execution context exports access in tests");
      },
      passThroughOnException() {},
      waitUntil(promise: Promise<unknown>) {
        waitUntilPromises.push(promise);
      },
      abort() {
        throw new Error("Unexpected execution context abort in tests");
      },
      props: undefined,
      tracing: createUnusedTracing(),
    },
    waitUntilPromises,
  };
}

function createBindings(): Bindings {
  return {
    AUTHORIZED_GUILD_ID: "guild-1",
    CALLS_APP_ID: "calls-app-id",
    CALLS_APP_SECRET: "calls-app-secret",
    DISCORD_CLIENT_ID: "discord-client-id",
    DISCORD_CLIENT_SECRET: "discord-client-secret",
    ENVIRONMENT: "production",
    JWT_SECRET: "test-jwt-secret",
    LIVE_DB: createUnusedD1Database(),
    LIVE_TOKEN_PEPPER: "test-live-token-pepper",
    LOG_LEVEL: "info",
    NOTIFICATIONS_DISCORD_WEBHOOK_URL:
      "https://discord.com/api/webhooks/123/token",
    TURN_KEY_API_TOKEN: "turn-key-api-token",
    TURN_KEY_ID: "turn-key-id",
  };
}

async function createAuthCookie(
  env: Bindings,
  overrides?: Partial<{
    displayName: string;
    userId: string;
  }>,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    {
      displayName: overrides?.displayName ?? "Viewer",
      exp: now + 60 * 60,
      iat: now,
      userId: overrides?.userId ?? "viewer-1",
    },
    env.JWT_SECRET,
    "HS256",
  );

  return `authtoken=${token}`;
}

async function requestPlayOffer(
  env: Bindings,
  executionContext: ExecutionContext = createExecutionContext(),
): Promise<Response> {
  return app.fetch(
    new Request("http://localhost/play/streamer-1", {
      body: "viewer-offer",
      headers: {
        Cookie: await createAuthCookie(env),
        "Content-Type": "application/sdp",
      },
      method: "POST",
    }),
    env,
    executionContext,
  );
}

async function requestLoginCallback(
  env: Bindings,
  query: Record<string, string>,
  stateCookie: string | null = "oauth-state",
): Promise<Response> {
  const headers = new Headers();
  if (stateCookie !== null) {
    headers.set("Cookie", `discord_oauth_state=${stateCookie}`);
  }
  const url = new URL("http://localhost/login/callback");
  url.search = new URLSearchParams(query).toString();
  return app.fetch(
    new Request(url, { headers }),
    env,
    createExecutionContext(),
  );
}

function getSetCookieValue(response: Response, name: string): string {
  const setCookie = response.headers.get("set-cookie");
  const cookie = setCookie
    ?.split(/, (?=[^;,]+=)/u)
    .find((value) => value.startsWith(`${name}=`));
  if (cookie === undefined) {
    throw new Error(`Missing ${name} cookie`);
  }
  return cookie;
}

async function expectPlayNotFoundAndCleanup(
  response: Response,
  env: Bindings,
): Promise<void> {
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("Live stream not found: streamer-1");
  expect(dbMocks.deleteLiveForSession).toHaveBeenCalledWith(
    env.LIVE_DB,
    "streamer-1",
    "live-session",
  );
}

describe("worker app", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    dbMocks.deleteLiveForSession.mockResolvedValue(true);
    dbMocks.getAllLives.mockResolvedValue([]);
    dbMocks.getLiveTokenHash.mockResolvedValue(
      await hashTokenWithPepper("test-live-token-pepper", "live-token"),
    );
    dbMocks.getLive.mockResolvedValue(null);
    dbMocks.hasLiveToken.mockResolvedValue(false);
    dbMocks.setLiveToken.mockResolvedValue();
    dbMocks.insertLive.mockResolvedValue();
    dbMocks.setLiveNotificationMessageId.mockResolvedValue(true);
    dbMocks.setUser.mockResolvedValue();

    discordMocks.buildDiscordAuthorizationUrl.mockReset();
    discordMocks.buildDiscordAuthorizationUrl.mockImplementation(
      (_env, redirectUri, state) =>
        `https://discord.com/oauth2/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`,
    );
    discordMocks.createOAuthState.mockReset();
    discordMocks.createOAuthState.mockReturnValue("oauth-state");
    discordMocks.exchangeCodeForToken.mockReset();
    discordMocks.exchangeCodeForToken.mockResolvedValue(
      ok<DiscordOAuthToken>({
        accessToken: "discord-access-token",
        expiresIn: 3600,
        scope: "identify guilds.members.read",
        tokenType: "Bearer",
      }),
    );
    discordMocks.getDiscordErrorMessage.mockReset();
    discordMocks.getDiscordErrorMessage.mockReturnValue(
      "Discord request failed",
    );
    discordMocks.getGuildMember.mockReset();
    discordMocks.getGuildMember.mockResolvedValue(
      ok<DiscordGuildMember>({
        nick: null,
        user: {
          discriminator: null,
          global_name: "Alice",
          id: "user-1",
          username: "alice",
        },
      }),
    );
    discordMocks.revokeAccessToken.mockReset();
    discordMocks.revokeAccessToken.mockResolvedValue(ok(undefined));

    callsMocks.closeTracks.mockResolvedValue(ok({}));
    callsMocks.isSessionActive.mockResolvedValue(ok(true));
    callsMocks.renegotiateSession.mockResolvedValue(ok(new Response(null)));
    callsMocks.startIngest.mockReset();
    callsMocks.startIngest.mockResolvedValue(
      ok({
        sdpAnswer: "answer-sdp",
        sessionId: "new-session",
        tracks: [
          {
            location: "remote",
            mid: "0",
            sessionId: "new-session",
            trackName: "video",
          },
        ],
      }),
    );
    callsMocks.startPlay.mockReset();
    callsMocks.startPlay.mockResolvedValue(
      ok({
        sdpAnswer: "viewer-answer-sdp",
        sessionId: "viewer-session",
        sdpType: "answer",
        tracks: [
          {
            location: "remote",
            mid: "0",
            sessionId: "viewer-session",
            trackName: "video",
          },
        ],
      }),
    );
    notificationsMocks.deleteLiveStartedNotification.mockReset();
    notificationsMocks.deleteLiveStartedNotification.mockResolvedValue(
      ok(undefined),
    );
    notificationsMocks.sendLiveStartedNotification.mockReset();
    notificationsMocks.sendLiveStartedNotification.mockResolvedValue(
      ok({ messageId: 1n }),
    );
    turnMocks.generateTurnIceServers.mockReset();
    turnMocks.generateTurnIceServers.mockResolvedValue(
      ok([
        {
          urls: ["stun:stun.cloudflare.com:3478"],
        },
      ]),
    );
  });

  it("redirects to Discord when login starts", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/login?ignored=secret"),
      env,
      createExecutionContext(),
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
    const response = await app.fetch(
      new Request("http://localhost/logout", {
        headers: { Cookie: "authtoken=existing", Origin: "http://localhost" },
        method: "POST",
      }),
      createBindings(),
      createExecutionContext(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/");
    expect(response.headers.get("set-cookie")).toContain("authtoken=;");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });

  it("rejects Discord login when the OAuth state is invalid", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request(
        "http://localhost/login/callback?code=auth-code&state=wrong-state",
        {
          headers: {
            Cookie: "discord_oauth_state=oauth-state",
          },
        },
      ),
      env,
      createExecutionContext(),
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
      const response = await requestLoginCallback(
        createBindings(),
        query,
        stateCookie,
      );

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
      const response = await requestLoginCallback(createBindings(), query);

      expect(response.status).toBe(401);
      expect(await response.text()).toBe(expectedBody);
      expect(discordMocks.exchangeCodeForToken).not.toHaveBeenCalled();
    },
  );

  it("requires a code after validating OAuth state", async () => {
    const response = await requestLoginCallback(createBindings(), {
      state: "oauth-state",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("Authorization code is required");
    expect(discordMocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("maps OAuth token exchange errors to a logged 502 response", async () => {
    discordMocks.exchangeCodeForToken.mockResolvedValue(
      err(
        new discordMocks.DiscordApiError("token exchange failed", {
          endpoint: "https://discord.com/api/oauth2/token",
          kind: "http_error",
          statusText: "Bad Gateway",
        }),
      ),
    );

    const response = await requestLoginCallback(createBindings(), {
      code: "auth-code",
      state: "oauth-state",
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      "Discord login failed: Discord request failed",
    );
    expect(console.error).toHaveBeenCalledWith(
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
    vi.useFakeTimers();
    const now = Date.UTC(2025, 0, 1);
    vi.setSystemTime(now);
    const env = createBindings();

    const response = await app.fetch(
      new Request(
        "http://localhost/login/callback?code=auth-code&state=oauth-state",
        {
          headers: {
            Cookie: "discord_oauth_state=oauth-state",
          },
        },
      ),
      env,
      createExecutionContext(),
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
    expect(dbMocks.setUser).toHaveBeenCalledWith(env.LIVE_DB, {
      displayName: "Alice",
      userId: "user-1",
    });
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
    if (!token) {
      throw new Error("Login response did not contain an auth token");
    }
    const payload = await verify(token, env.JWT_SECRET, "HS256");
    expect(payload).toMatchObject({ displayName: "Alice", userId: "user-1" });
    expect(payload.iat).toBe(now / 1000);
    expect(payload.exp).toBe(now / 1000 + 86_400);
    expect(authCookie).toContain(
      `Expires=${new Date(now + 86_400_000).toUTCString()}`,
    );
    expect(console.warn).not.toHaveBeenCalled();
  });

  it("omits Secure cookies outside production", async () => {
    const env = createBindings();
    env.ENVIRONMENT = "development";

    const response = await requestLoginCallback(env, {
      code: "auth-code",
      state: "oauth-state",
    });

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
      discordMocks.getGuildMember.mockResolvedValue(
        ok<DiscordGuildMember>({
          nick,
          user: {
            discriminator: null,
            global_name: globalName,
            id: "user-1",
            username,
          },
        }),
      );

      const response = await requestLoginCallback(createBindings(), {
        code: "auth-code",
        state: "oauth-state",
      });

      expect(response.status).toBe(302);
      expect(dbMocks.setUser).toHaveBeenCalledWith(expect.anything(), {
        displayName,
        userId: "user-1",
      });
    },
  );

  it("keeps successful login when Discord token revocation fails", async () => {
    discordMocks.revokeAccessToken.mockResolvedValue(
      err(
        new discordMocks.DiscordApiError("revocation failed", {
          endpoint: "https://discord.com/api/oauth2/token/revoke",
          kind: "http_error",
          statusText: "Bad Gateway",
        }),
      ),
    );

    const response = await requestLoginCallback(createBindings(), {
      code: "auth-code",
      state: "oauth-state",
    });

    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("authtoken=");
    expect(console.warn).toHaveBeenCalledWith(
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
    const env = createBindings();

    discordMocks.getGuildMember.mockResolvedValue(
      err(
        new discordMocks.DiscordApiError("Discord request failed: not found", {
          endpoint: `https://discord.com/api/v10/users/@me/guilds/${env.AUTHORIZED_GUILD_ID}/member`,
          kind: "not_found",
          statusText: "Not Found",
        }),
      ),
    );

    const response = await app.fetch(
      new Request(
        "http://localhost/login/callback?code=auth-code&state=oauth-state",
        {
          headers: {
            Cookie: "discord_oauth_state=oauth-state",
          },
        },
      ),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe(
      "Unauthorized: You are not a member of the authorized Discord server",
    );
    expect(discordMocks.revokeAccessToken).toHaveBeenCalledWith(
      env,
      "discord-access-token",
    );
    expect(dbMocks.setUser).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
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
      const env = createBindings();
      const endpoint = matchingEndpoint
        ? `https://discord.com/api/v10/users/@me/guilds/${env.AUTHORIZED_GUILD_ID}/member`
        : "https://discord.com/api/v10/users/@me/guilds/another-guild/member";
      discordMocks.getGuildMember.mockResolvedValue(
        err(
          new discordMocks.DiscordApiError("member lookup failed", {
            endpoint,
            kind,
            statusText: "Forbidden",
          }),
        ),
      );

      const response = await requestLoginCallback(env, {
        code: "auth-code",
        state: "oauth-state",
      });

      expect(response.status).toBe(expectedStatus);
      expect(await response.text()).toBe(
        expectedStatus === 401
          ? "Unauthorized: You are not a member of the authorized Discord server"
          : "Discord login failed: Discord request failed",
      );
      expect(discordMocks.revokeAccessToken).toHaveBeenCalledWith(
        env,
        "discord-access-token",
      );
      expect(dbMocks.setUser).not.toHaveBeenCalled();
    },
  );

  it("issues a live token for an authenticated user", async () => {
    const env = createBindings();
    const request = new Request("http://localhost/api/me/livetoken", {
      headers: {
        Cookie: await createAuthCookie(env, { userId: "user-1" }),
        Origin: "http://localhost",
      },
      method: "POST",
    });

    const response = await app.fetch(request, env, createExecutionContext());

    expect(response.status).toBe(200);

    const body: {
      success: boolean;
      token: string;
    } = await response.json();

    expect(body.success).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/u);
    const expectedTokenHash = await hashTokenWithPepper(
      env.LIVE_TOKEN_PEPPER,
      body.token,
    );
    expect(dbMocks.setLiveToken).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      expectedTokenHash,
    );
  });

  it("returns a worker error when saving a new live token fails", async () => {
    const env = createBindings();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    dbMocks.setLiveToken.mockRejectedValue(new Error("database unavailable"));

    const response = await app.fetch(
      new Request("http://localhost/api/me/livetoken", {
        headers: {
          Cookie: await createAuthCookie(env, { userId: "user-1" }),
          Origin: "http://localhost",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Failed to save live token");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "database unavailable",
        event: "live_token.save_failed",
        level: "error",
        userId: "user-1",
      }),
    );
  });

  it("returns live-token status and maps database failures to 500", async () => {
    const env = createBindings();
    const cookie = await createAuthCookie(env, { userId: "user-1" });
    dbMocks.hasLiveToken.mockResolvedValue(true);

    const success = await app.fetch(
      new Request("http://localhost/api/me/livetoken", {
        headers: { Cookie: cookie },
      }),
      env,
      createExecutionContext(),
    );
    expect(success.status).toBe(200);
    await expect(success.json()).resolves.toEqual({ hasToken: true });
    expect(dbMocks.hasLiveToken).toHaveBeenCalledWith(env.LIVE_DB, "user-1");

    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    dbMocks.hasLiveToken.mockRejectedValue(new Error("database unavailable"));
    const failed = await app.fetch(
      new Request("http://localhost/api/me/livetoken", {
        headers: { Cookie: cookie },
      }),
      env,
      createExecutionContext(),
    );
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("Failed to check live token");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "database unavailable",
        event: "live_token.status_check_failed",
        level: "error",
        userId: "user-1",
      }),
    );
  });

  it("lists stored live streams for an authenticated app user", async () => {
    const env = createBindings();
    const lives = [
      {
        owner: { displayName: "Streamer", userId: "streamer-1" },
      },
    ];
    dbMocks.getAllLives.mockResolvedValue(lives);

    const response = await app.fetch(
      new Request("http://localhost/api/lives", {
        headers: { Cookie: await createAuthCookie(env) },
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(lives);
    expect(dbMocks.getAllLives).toHaveBeenCalledWith(env.LIVE_DB);
  });

  it("returns HTTP exceptions unchanged from the worker error boundary", async () => {
    const env = createBindings();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    dbMocks.getAllLives.mockRejectedValue(
      new HTTPException(418, {
        res: new Response("preserved response", { status: 418 }),
      }),
    );

    const response = await app.fetch(
      new Request("http://localhost/api/lives", {
        headers: { Cookie: await createAuthCookie(env) },
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(418);
    expect(await response.text()).toBe("preserved response");
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("logs unexpected errors from API handlers and returns a generic response", async () => {
    const env = createBindings();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    dbMocks.getAllLives.mockRejectedValue(new Error("database offline"));

    const response = await app.fetch(
      new Request("http://localhost/api/lives", {
        headers: { Cookie: await createAuthCookie(env) },
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "database offline",
        event: "worker.unhandled_error",
        level: "error",
      }),
    );
  });

  it("returns the authenticated profile payload", async () => {
    const env = createBindings();
    const consoleInfoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => {});
    const response = await app.fetch(
      new Request("http://localhost/api/me", {
        headers: {
          Cookie: await createAuthCookie(env, {
            displayName: "Viewer Name",
            userId: "viewer-7",
          }),
        },
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      displayName: "Viewer Name",
      userId: "viewer-7",
    });
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "api.request",
        level: "info",
        userId: "viewer-7",
      }),
    );
  });

  it("returns authenticated TURN credentials with no-store caching", async () => {
    const env = createBindings();
    const request = new Request("http://localhost/api/turn-credentials", {
      headers: {
        Cookie: await createAuthCookie(env, { userId: "viewer-1" }),
      },
    });

    const response = await app.fetch(request, env, createExecutionContext());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(turnMocks.generateTurnIceServers).toHaveBeenCalledWith(
      env,
      "viewer-1",
    );
    await expect(response.json()).resolves.toEqual({
      iceServers: [
        {
          urls: ["stun:stun.cloudflare.com:3478"],
        },
      ],
    });
  });

  it("maps TURN credential timeouts to 504", async () => {
    const env = createBindings();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    turnMocks.generateTurnIceServers.mockResolvedValue(
      err({
        kind: "request_timeout",
      }),
    );
    const request = new Request("http://localhost/api/turn-credentials", {
      headers: {
        Cookie: await createAuthCookie(env, { userId: "viewer-1" }),
      },
    });

    const response = await app.fetch(request, env, createExecutionContext());

    expect(response.status).toBe(504);
    expect(await response.text()).toBe("Failed to generate TURN credentials");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "request_timeout",
        event: "turn_credentials.generate_failed",
        level: "error",
        userId: "viewer-1",
      }),
    );
  });

  it("maps non-timeout TURN credential failures to 502", async () => {
    const env = createBindings();
    turnMocks.generateTurnIceServers.mockResolvedValue(
      err({ kind: "request_failed" }),
    );

    const response = await app.fetch(
      new Request("http://localhost/api/turn-credentials", {
        headers: {
          Cookie: await createAuthCookie(env, { userId: "viewer-1" }),
        },
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to generate TURN credentials");
  });

  it("rejects ingest when the bearer token does not match the stored hash", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer wrong-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(callsMocks.startIngest).not.toHaveBeenCalled();
  });

  it("starts ingest after removing a stale live row", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const consoleInfoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => {});
    const staleTracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "stale-session",
        trackName: "video",
      },
    ];

    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 2n,
      sessionId: "stale-session",
      tracks: staleTracks,
      userId: "user-1",
    });
    callsMocks.isSessionActive.mockResolvedValue(ok(false));

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(201);
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ingest.request",
        level: "info",
        userId: "user-1",
      }),
    );
    expect(response.headers.get("protocol-version")).toBeNull();
    expect(dbMocks.deleteLiveForSession).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      "stale-session",
    );
    expect(callsMocks.startIngest).toHaveBeenCalledWith(
      env,
      "user-1",
      "offer-sdp",
    );
    expect(dbMocks.insertLive).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      "new-session",
      [
        {
          location: "remote",
          mid: "0",
          sessionId: "new-session",
          trackName: "video",
        },
      ],
    );
    expect(execution.waitUntilPromises).toHaveLength(2);

    await Promise.all(execution.waitUntilPromises);

    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).toHaveBeenCalledWith(env, 2n);
    expect(notificationsMocks.sendLiveStartedNotification).toHaveBeenCalledWith(
      env,
      "user-1",
      "http://localhost/",
    );
    expect(dbMocks.setLiveNotificationMessageId).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      "new-session",
      1n,
    );
    expect(response.headers.get("location")).toBe("/ingest/user-1/new-session");
    expect(response.headers.get("content-type")).toBe("application/sdp");
    expect(response.headers.get("etag")).toBe('"new-session"');
    expect(await response.text()).toBe("answer-sdp");
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it.each([null, undefined] as const)(
    "does not delete a stale ingest notification without an ID (%s)",
    async (notificationMessageId) => {
      const env = createBindings();
      const execution = createObservedExecutionContext();
      dbMocks.getLive.mockResolvedValue({
        notificationMessageId,
        sessionId: "stale-session",
        tracks: [],
        userId: "user-1",
      });
      callsMocks.isSessionActive.mockResolvedValue(ok(false));

      const response = await app.fetch(
        new Request("http://localhost/ingest/user-1?notify=false", {
          body: "offer-sdp",
          headers: {
            Authorization: "Bearer live-token",
            "Content-Type": "application/sdp",
          },
          method: "POST",
        }),
        env,
        execution.context,
      );

      expect(response.status).toBe(201);
      expect(
        notificationsMocks.deleteLiveStartedNotification,
      ).not.toHaveBeenCalled();
      expect(execution.waitUntilPromises).toHaveLength(0);
    },
  );

  it("does not clean up an ingest notification when stale-row deletion fails", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 7n,
      sessionId: "stale-session",
      tracks: [],
      userId: "user-1",
    });
    dbMocks.deleteLiveForSession.mockResolvedValue(false);
    callsMocks.isSessionActive.mockResolvedValue(ok(false));

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1?notify=false", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(201);
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
  });

  it("schedules the live start notification via waitUntil", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    const response = await app.fetch(
      new Request("https://wish-broad.example/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(201);
    expect(execution.waitUntilPromises).toHaveLength(1);

    await Promise.all(execution.waitUntilPromises);

    expect(notificationsMocks.sendLiveStartedNotification).toHaveBeenCalledWith(
      env,
      "user-1",
      "https://wish-broad.example/",
    );
    expect(dbMocks.setLiveNotificationMessageId).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      "new-session",
      1n,
    );
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it("keeps ingest successful when the live start notification fails", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    notificationsMocks.sendLiveStartedNotification.mockResolvedValue(
      err(new Error("webhook failed")),
    );

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(201);

    await Promise.all(execution.waitUntilPromises);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "webhook failed",
        errorName: "Error",
        event: "live_notification.send_failed",
        level: "warn",
        sessionId: "new-session",
        userId: "user-1",
      }),
    );
    expect(dbMocks.setLiveNotificationMessageId).not.toHaveBeenCalled();
  });

  it("deletes an orphaned start notification when the live row disappears before persistence", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    dbMocks.setLiveNotificationMessageId.mockResolvedValue(false);

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(201);

    await Promise.all(execution.waitUntilPromises);

    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).toHaveBeenCalledWith(env, 1n);
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it("deletes the notification and logs when persisting its id throws", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    dbMocks.setLiveNotificationMessageId.mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      execution.context,
    );
    expect(response.status).toBe(201);
    await Promise.all(execution.waitUntilPromises);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "database unavailable",
        event: "live_notification.persist_failed",
        level: "warn",
        messageId: 1n,
        sessionId: "new-session",
        userId: "user-1",
      }),
    );
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).toHaveBeenCalledWith(env, 1n);
  });

  it("logs if deleting an orphaned start notification also fails", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    dbMocks.setLiveNotificationMessageId.mockResolvedValue(false);
    notificationsMocks.deleteLiveStartedNotification.mockResolvedValue(
      err(new Error("discord delete failed")),
    );

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      execution.context,
    );
    expect(response.status).toBe(201);
    await Promise.all(execution.waitUntilPromises);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "discord delete failed",
        event: "live_notification.orphan_delete_failed",
        level: "warn",
        messageId: 1n,
        sessionId: "new-session",
      }),
    );
  });

  it("returns 204 for GET on the WHIP endpoint", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        headers: {
          Authorization: "Bearer live-token",
        },
        method: "GET",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("returns 204 for GET on the WHIP session resource", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: {
          Authorization: "Bearer live-token",
        },
        method: "GET",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("rejects ingest when Content-Type is not application/sdp", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "text/plain",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(415);
    expect(await response.text()).toBe("Content-Type must be application/sdp");
    expect(callsMocks.startIngest).not.toHaveBeenCalled();
  });

  it.each([
    [
      "missing Content-Type",
      { body: "offer-sdp", headers: {} },
      415,
      "Content-Type must be application/sdp",
    ],
    [
      "an empty offer",
      { body: "", headers: { "Content-Type": "application/sdp" } },
      400,
      "SDP offer is required",
    ],
    [
      "a whitespace-only offer",
      { body: "   ", headers: { "Content-Type": "application/sdp" } },
      400,
      "SDP offer is required",
    ],
  ])(
    "rejects ingest with %s",
    async (_label, requestOptions, status, expectedBody) => {
      const env = createBindings();
      const request = new Request("http://localhost/ingest/user-1", {
        ...requestOptions,
        headers: {
          Authorization: "Bearer live-token",
          ...requestOptions.headers,
        },
        method: "POST",
      });
      if (_label === "missing Content-Type") {
        request.headers.delete("Content-Type");
      }
      const response = await app.fetch(request, env, createExecutionContext());

      expect(response.status).toBe(status);
      expect(await response.text()).toBe(expectedBody);
      expect(callsMocks.startIngest).not.toHaveBeenCalled();
    },
  );

  it("accepts case-insensitive SDP content types with parameters and spacing", async () => {
    const env = createBindings();
    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/SDP ; charset=utf-8",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(201);
    expect(callsMocks.startIngest).toHaveBeenCalledWith(
      env,
      "user-1",
      "offer-sdp",
    );
  });

  it.each(["false", "0"])(
    "honors notify=%s when starting an ingest session",
    async (notify) => {
      const env = createBindings();
      const execution = createObservedExecutionContext();
      const response = await app.fetch(
        new Request(`http://localhost/ingest/user-1?notify=${notify}`, {
          body: "offer-sdp",
          headers: {
            Authorization: "Bearer live-token",
            "Content-Type": "application/sdp",
          },
          method: "POST",
        }),
        env,
        execution.context,
      );

      expect(response.status).toBe(201);
      expect(execution.waitUntilPromises).toHaveLength(0);
      expect(
        notificationsMocks.sendLiveStartedNotification,
      ).not.toHaveBeenCalled();
    },
  );

  it("rejects stale-ingest checks when Calls cannot verify the stored session", async () => {
    const env = createBindings();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    dbMocks.getLive.mockResolvedValue({
      sessionId: "stale-session",
      tracks: [],
      userId: "user-1",
    });
    callsMocks.isSessionActive.mockResolvedValue(
      err(
        new SfuApiError("Calls request failed", {
          endpoint: "/sessions/stale-session",
          kind: "request_failed",
        }),
      ),
    );

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      "Failed to verify ingest session status",
    );
    expect(dbMocks.deleteLiveForSession).not.toHaveBeenCalled();
    expect(callsMocks.startIngest).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/sessions/stale-session",
        errorKind: "request_failed",
        event: "ingest.session_activity_check_failed",
        sessionId: "stale-session",
        userId: "user-1",
      }),
    );
  });

  it("logs an orphan notification deletion failure during ingest replacement", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 9n,
      sessionId: "stale-session",
      tracks: [],
      userId: "user-1",
    });
    callsMocks.isSessionActive.mockResolvedValue(ok(false));
    notificationsMocks.deleteLiveStartedNotification.mockResolvedValue(
      err(new Error("discord delete failed")),
    );

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      execution.context,
    );
    expect(response.status).toBe(201);
    await Promise.all(execution.waitUntilPromises);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "discord delete failed",
        event: "live_notification.delete_failed",
        level: "warn",
        messageId: 9n,
        sessionId: "stale-session",
      }),
    );
  });

  it("returns SFU client errors for invalid ingest offers", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();

    callsMocks.startIngest.mockResolvedValue(
      err(
        new SfuApiError("SFU request failed: unprocessable content", {
          endpoint: "/tracks/new",
          kind: "unprocessable_content",
          responseBody: "Malformed SDP offer",
          statusText: "Unprocessable Content",
        }),
      ),
    );

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toBe("Malformed SDP offer");
    expect(
      notificationsMocks.sendLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
  });

  it("keeps SFU auth failures as worker errors during ingest", async () => {
    const env = createBindings();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    callsMocks.startIngest.mockResolvedValue(
      err(
        new SfuApiError("SFU request failed", {
          endpoint: "/sessions/new",
          kind: "http_error",
          responseBody: "SFU auth failed",
          statusText: "Unauthorized",
        }),
      ),
    );

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/sessions/new",
        errorKind: "http_error",
        errorMessage: "SFU request failed",
        event: "ingest.negotiation_failed",
        level: "error",
        userId: "user-1",
      }),
    );
  });

  it("rejects a new ingest when the user already has an active live", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();

    dbMocks.getLive.mockResolvedValue({
      sessionId: "active-session",
      tracks: [
        {
          location: "remote",
          mid: "0",
          sessionId: "active-session",
          trackName: "video",
        },
      ],
      userId: "user-1",
    });
    callsMocks.isSessionActive.mockResolvedValue(ok(true));

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "A live stream is already active for this user",
    );
    expect(dbMocks.deleteLiveForSession).not.toHaveBeenCalled();
    expect(callsMocks.startIngest).not.toHaveBeenCalled();
    expect(dbMocks.insertLive).not.toHaveBeenCalled();
    expect(
      notificationsMocks.sendLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
  });

  it("does not schedule a notification when persisting the live row fails", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();

    dbMocks.insertLive.mockRejectedValue(new Error("insert failed"));

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(
      notificationsMocks.sendLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
  });

  it("closes publisher tracks before deleting an ingest session", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleInfoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => {});
    const tracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "session-1",
        trackName: "video",
      },
    ];

    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 1n,
      sessionId: "session-1",
      tracks,
      userId: "user-1",
    });

    const request = new Request("http://localhost/ingest/user-1/session-1", {
      headers: {
        Authorization: "Bearer live-token",
      },
      method: "DELETE",
    });

    const response = await app.fetch(request, env, execution.context);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ingest.request",
        level: "info",
        sessionId: "session-1",
        userId: "user-1",
      }),
    );
    expect(dbMocks.deleteLiveForSession).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      "session-1",
    );
    expect(execution.waitUntilPromises).toHaveLength(2);

    await Promise.all(execution.waitUntilPromises);

    expect(callsMocks.closeTracks).toHaveBeenCalledWith(
      env,
      "session-1",
      tracks,
    );
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).toHaveBeenCalledWith(env, 1n);
  });

  it.each([null, undefined] as const)(
    "does not delete a publisher notification without an ID (%s)",
    async (notificationMessageId) => {
      const env = createBindings();
      const execution = createObservedExecutionContext();
      dbMocks.getLive.mockResolvedValue({
        notificationMessageId,
        sessionId: "session-1",
        tracks: [
          {
            location: "remote",
            mid: "0",
            sessionId: "session-1",
            trackName: "video",
          },
        ],
        userId: "user-1",
      });

      const response = await app.fetch(
        new Request("http://localhost/ingest/user-1/session-1", {
          headers: { Authorization: "Bearer live-token" },
          method: "DELETE",
        }),
        env,
        execution.context,
      );

      expect(response.status).toBe(200);
      await Promise.all(execution.waitUntilPromises);
      expect(
        notificationsMocks.deleteLiveStartedNotification,
      ).not.toHaveBeenCalled();
      expect(execution.waitUntilPromises).toHaveLength(1);
    },
  );

  it("rejects ingest deletion when there is no live row", async () => {
    const env = createBindings();
    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: { Authorization: "Bearer live-token" },
        method: "DELETE",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("No live stream found for this user");
    expect(dbMocks.deleteLiveForSession).not.toHaveBeenCalled();
    expect(callsMocks.closeTracks).not.toHaveBeenCalled();
  });

  it("logs notification cleanup failures after an ingest row is deleted", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 9n,
      sessionId: "session-1",
      tracks: [
        {
          location: "remote",
          mid: "0",
          sessionId: "session-1",
          trackName: "video",
        },
      ],
      userId: "user-1",
    });
    notificationsMocks.deleteLiveStartedNotification.mockResolvedValue(
      err(new Error("discord delete failed")),
    );

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: { Authorization: "Bearer live-token" },
        method: "DELETE",
      }),
      env,
      execution.context,
    );
    expect(response.status).toBe(200);
    await Promise.all(execution.waitUntilPromises);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "discord delete failed",
        event: "live_notification.delete_failed",
        level: "warn",
        messageId: 9n,
        sessionId: "session-1",
      }),
    );
  });

  it("returns success and logs when ingest close reports track errors", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 1n,
      sessionId: "session-1",
      tracks: [
        {
          location: "remote",
          mid: "0",
          sessionId: "session-1",
          trackName: "video",
        },
      ],
      userId: "user-1",
    });
    callsMocks.closeTracks.mockResolvedValue(
      ok({
        tracks: [{ mid: "0" }, { errorCode: "failed_to_close", mid: "1" }],
      }),
    );

    const request = new Request("http://localhost/ingest/user-1/session-1", {
      headers: {
        Authorization: "Bearer live-token",
      },
      method: "DELETE",
    });

    const response = await app.fetch(request, env, execution.context);

    expect(response.status).toBe(200);
    expect(dbMocks.deleteLiveForSession).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      "session-1",
    );

    await Promise.all(execution.waitUntilPromises);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "track_close.sfu_errors",
        level: "warn",
        message: "SFU reported track close errors for user user-1:",
        response: {
          tracks: [{ mid: "0" }, { errorCode: "failed_to_close", mid: "1" }],
        },
        sessionId: "session-1",
      }),
    );
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).toHaveBeenCalledWith(env, 1n);
  });

  it("does not warn when a track close succeeds without per-track errors", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    dbMocks.getLive.mockResolvedValue({
      sessionId: "session-1",
      tracks: [
        {
          location: "remote",
          mid: "0",
          sessionId: "session-1",
          trackName: "video",
        },
      ],
      userId: "user-1",
    });
    callsMocks.closeTracks.mockResolvedValue(ok({ tracks: [{ mid: "0" }] }));

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: { Authorization: "Bearer live-token" },
        method: "DELETE",
      }),
      env,
      execution.context,
    );
    expect(response.status).toBe(200);
    await Promise.all(execution.waitUntilPromises);
    expect(consoleWarnSpy).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "track_close.sfu_errors" }),
    );
  });

  it("returns success when ingest close says tracks are already gone", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();

    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 1n,
      sessionId: "session-1",
      tracks: [
        {
          location: "remote",
          mid: "0",
          sessionId: "session-1",
          trackName: "video",
        },
      ],
      userId: "user-1",
    });
    callsMocks.closeTracks.mockResolvedValue(
      err(
        new SfuApiError("SFU request failed: session not found", {
          endpoint: "/tracks/close",
          kind: "session_not_found",
          statusText: "Not Found",
        }),
      ),
    );

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: {
          Authorization: "Bearer live-token",
        },
        method: "DELETE",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(200);
    expect(dbMocks.deleteLiveForSession).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      "session-1",
    );

    await Promise.all(execution.waitUntilPromises);

    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).toHaveBeenCalledWith(env, 1n);
  });

  it.each(["session_not_found", "session_gone"] as const)(
    "treats an already-gone ingest session as successful cleanup (%s)",
    async (kind) => {
      const env = createBindings();
      const execution = createObservedExecutionContext();
      const consoleWarnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      dbMocks.getLive.mockResolvedValue({
        sessionId: "session-1",
        tracks: [
          {
            location: "remote",
            mid: "0",
            sessionId: "session-1",
            trackName: "video",
          },
        ],
        userId: "user-1",
      });
      callsMocks.closeTracks.mockResolvedValue(
        err(
          new SfuApiError("Session already gone", {
            endpoint: "/tracks/close",
            kind,
          }),
        ),
      );

      const response = await app.fetch(
        new Request("http://localhost/ingest/user-1/session-1", {
          headers: { Authorization: "Bearer live-token" },
          method: "DELETE",
        }),
        env,
        execution.context,
      );
      expect(response.status).toBe(200);
      await Promise.all(execution.waitUntilPromises);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    },
  );

  it("logs unexpected track-close failures without undoing ingest deletion", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    dbMocks.getLive.mockResolvedValue({
      sessionId: "session-1",
      tracks: [
        {
          location: "remote",
          mid: "0",
          sessionId: "session-1",
          trackName: "video",
        },
      ],
      userId: "user-1",
    });
    callsMocks.closeTracks.mockResolvedValue(
      err(
        new SfuApiError("Calls unavailable", {
          endpoint: "/tracks/close",
          kind: "request_failed",
        }),
      ),
    );

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: { Authorization: "Bearer live-token" },
        method: "DELETE",
      }),
      env,
      execution.context,
    );
    expect(response.status).toBe(200);
    await Promise.all(execution.waitUntilPromises);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "Calls unavailable",
        event: "track_close.failed",
        level: "warn",
        sessionId: "session-1",
      }),
    );
  });

  it("rejects ingest deletion when the session id does not match", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();

    dbMocks.getLive.mockResolvedValue({
      sessionId: "actual-session",
      tracks: [
        {
          location: "remote",
          mid: "0",
          sessionId: "actual-session",
          trackName: "video",
        },
      ],
      userId: "user-1",
    });

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/other-session", {
        headers: {
          Authorization: "Bearer live-token",
        },
        method: "DELETE",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Session ID does not match the active live stream",
    );
    expect(callsMocks.closeTracks).not.toHaveBeenCalled();
    expect(dbMocks.deleteLiveForSession).not.toHaveBeenCalled();
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
  });

  it("returns 500 when stored live track data is invalid on ingest delete", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();

    dbMocks.getLive.mockResolvedValue({
      sessionId: "session-1",
      tracks: [
        {
          location: "remote",
          mid: "0",
          sessionId: "session-1",
          trackName: "video",
        },
        {
          location: "remote",
          mid: "",
          sessionId: "session-1",
          trackName: "video",
        },
      ],
      userId: "user-1",
    });

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: {
          Authorization: "Bearer live-token",
        },
        method: "DELETE",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Stored live track data is invalid");
    expect(callsMocks.closeTracks).not.toHaveBeenCalled();
    expect(dbMocks.deleteLiveForSession).not.toHaveBeenCalled();
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
  });

  it("rejects stored ingest state with no tracks", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    dbMocks.getLive.mockResolvedValue({
      sessionId: "session-1",
      tracks: [],
      userId: "user-1",
    });

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: { Authorization: "Bearer live-token" },
        method: "DELETE",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Stored live track data is invalid");
    expect(dbMocks.deleteLiveForSession).not.toHaveBeenCalled();
    expect(callsMocks.closeTracks).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
  });

  it("does not schedule ingest close when deleting the live row fails", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();

    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 1n,
      sessionId: "session-1",
      tracks: [
        {
          location: "remote",
          mid: "0",
          sessionId: "session-1",
          trackName: "video",
        },
      ],
      userId: "user-1",
    });
    dbMocks.deleteLiveForSession.mockResolvedValue(false);

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: {
          Authorization: "Bearer live-token",
        },
        method: "DELETE",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Failed to delete the requested live stream",
    );
    expect(callsMocks.closeTracks).not.toHaveBeenCalled();
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
  });

  it("returns 404 and cleans up when a stored play session is inactive", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const liveTracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "live-session",
        trackName: "video",
      },
    ];

    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 1n,
      sessionId: "live-session",
      tracks: liveTracks,
      userId: "streamer-1",
    });
    callsMocks.isSessionActive.mockResolvedValue(ok(false));

    const response = await requestPlayOffer(env, execution.context);
    await expectPlayNotFoundAndCleanup(response, env);
    await Promise.all(execution.waitUntilPromises);
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).toHaveBeenCalledWith(env, 1n);
    expect(callsMocks.startPlay).not.toHaveBeenCalled();
  });

  it.each([null, undefined] as const)(
    "does not delete a stale playback notification without an ID (%s)",
    async (notificationMessageId) => {
      const env = createBindings();
      const execution = createObservedExecutionContext();
      dbMocks.getLive.mockResolvedValue({
        notificationMessageId,
        sessionId: "live-session",
        tracks: [],
        userId: "streamer-1",
      });
      callsMocks.isSessionActive.mockResolvedValue(ok(false));

      const response = await requestPlayOffer(env, execution.context);

      expect(response.status).toBe(404);
      expect(await response.text()).toBe("Live stream not found: streamer-1");
      await Promise.all(execution.waitUntilPromises);
      expect(
        notificationsMocks.deleteLiveStartedNotification,
      ).not.toHaveBeenCalled();
      expect(execution.waitUntilPromises).toHaveLength(0);
    },
  );

  it("does not delete a stale playback notification when row deletion fails", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 12n,
      sessionId: "live-session",
      tracks: [],
      userId: "streamer-1",
    });
    dbMocks.deleteLiveForSession.mockResolvedValue(false);
    callsMocks.isSessionActive.mockResolvedValue(ok(false));

    const response = await requestPlayOffer(env, execution.context);

    expect(response.status).toBe(404);
    expect(dbMocks.deleteLiveForSession).toHaveBeenCalledWith(
      env.LIVE_DB,
      "streamer-1",
      "live-session",
    );
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
  });

  it("returns a logged 502 when Calls cannot verify a play session", async () => {
    const env = createBindings();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    dbMocks.getLive.mockResolvedValue({
      sessionId: "live-session",
      tracks: [],
      userId: "streamer-1",
    });
    callsMocks.isSessionActive.mockResolvedValue(
      err(
        new SfuApiError("Calls request failed", {
          endpoint: "/sessions/live-session",
          kind: "request_failed",
        }),
      ),
    );

    const response = await requestPlayOffer(env);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to verify live stream status");
    expect(callsMocks.startPlay).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/sessions/live-session",
        errorKind: "request_failed",
        errorMessage: "Calls request failed",
        event: "play.session_activity_check_failed",
        level: "error",
        sessionId: "live-session",
        userId: "streamer-1",
      }),
    );
  });

  it("cleans the notification when stale-play cleanup cannot delete Discord's message", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 12n,
      sessionId: "live-session",
      tracks: [],
      userId: "streamer-1",
    });
    callsMocks.isSessionActive.mockResolvedValue(ok(false));
    notificationsMocks.deleteLiveStartedNotification.mockResolvedValue(
      err(new Error("discord delete failed")),
    );

    const response = await requestPlayOffer(env, execution.context);
    expect(response.status).toBe(404);
    await Promise.all(execution.waitUntilPromises);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "discord delete failed",
        event: "live_notification.delete_failed",
        messageId: 12n,
        sessionId: "live-session",
      }),
    );
  });

  it("maps a missing live from the playback negotiator to 404", async () => {
    const env = createBindings();
    callsMocks.startPlay.mockResolvedValue(
      err(new LiveNotFoundError("streamer-1")),
    );

    const response = await requestPlayOffer(env);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Live stream not found: streamer-1");
    expect(dbMocks.deleteLiveForSession).not.toHaveBeenCalled();
  });

  it("logs unexpected playback negotiation errors and returns 502", async () => {
    const env = createBindings();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    callsMocks.startPlay.mockResolvedValue(
      err(new Error("unexpected playback error")),
    );

    const response = await requestPlayOffer(env);

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to negotiate playback session");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "unexpected playback error",
        event: "play.negotiation_failed",
        level: "error",
        viewerUserId: "viewer-1",
      }),
    );
  });

  it("returns 404 and cleans up when SFU loses the live during play start", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const liveTracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "live-session",
        trackName: "video",
      },
    ];

    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 1n,
      sessionId: "live-session",
      tracks: liveTracks,
      userId: "streamer-1",
    });
    callsMocks.startPlay.mockResolvedValue(
      err(
        new SfuApiError("SFU request failed: session not found", {
          endpoint: "/tracks/new",
          kind: "session_not_found",
          statusText: "Not Found",
        }),
      ),
    );

    const response = await requestPlayOffer(env, execution.context);
    await expectPlayNotFoundAndCleanup(response, env);
    await Promise.all(execution.waitUntilPromises);
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).toHaveBeenCalledWith(env, 1n);
  });

  it.each([null, undefined] as const)(
    "does not delete an SFU-stale notification without an ID (%s)",
    async (notificationMessageId) => {
      const env = createBindings();
      const execution = createObservedExecutionContext();
      dbMocks.getLive.mockResolvedValue({
        notificationMessageId,
        sessionId: "live-session",
        tracks: [],
        userId: "streamer-1",
      });
      callsMocks.startPlay.mockResolvedValue(
        err(
          new SfuApiError("Session not found", {
            endpoint: "/tracks/new",
            kind: "session_not_found",
          }),
        ),
      );

      const response = await requestPlayOffer(env, execution.context);

      expect(response.status).toBe(404);
      await Promise.all(execution.waitUntilPromises);
      expect(
        notificationsMocks.deleteLiveStartedNotification,
      ).not.toHaveBeenCalled();
      expect(execution.waitUntilPromises).toHaveLength(0);
    },
  );

  it("logs failure to delete a notification after SFU loses the live", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 13n,
      sessionId: "live-session",
      tracks: [],
      userId: "streamer-1",
    });
    callsMocks.startPlay.mockResolvedValue(
      err(
        new SfuApiError("Session not found", {
          endpoint: "/tracks/new",
          kind: "session_not_found",
        }),
      ),
    );
    notificationsMocks.deleteLiveStartedNotification.mockResolvedValue(
      err(new Error("discord cleanup failed")),
    );

    const response = await requestPlayOffer(env, execution.context);

    expect(response.status).toBe(404);
    await Promise.all(execution.waitUntilPromises);
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "discord cleanup failed",
        event: "live_notification.delete_failed",
        level: "warn",
        messageId: 13n,
        sessionId: "live-session",
        userId: "streamer-1",
      }),
    );
  });

  it("does not clean the notification if the live row cannot be deleted after SFU loss", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 14n,
      sessionId: "live-session",
      tracks: [],
      userId: "streamer-1",
    });
    dbMocks.deleteLiveForSession.mockResolvedValue(false);
    callsMocks.startPlay.mockResolvedValue(
      err(
        new SfuApiError("Session not found", {
          endpoint: "/tracks/new",
          kind: "session_not_found",
        }),
      ),
    );

    const response = await requestPlayOffer(env, execution.context);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Live stream not found: streamer-1");
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
  });

  it("returns 404 when the SFU loses playback for an owner with no stored row", async () => {
    const env = createBindings();
    callsMocks.startPlay.mockResolvedValue(
      err(
        new SfuApiError("Session not found", {
          endpoint: "/tracks/new",
          kind: "session_not_found",
        }),
      ),
    );

    const response = await requestPlayOffer(env);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Live stream not found: streamer-1");
    expect(callsMocks.startPlay).toHaveBeenCalledWith(
      env,
      "streamer-1",
      [],
      "viewer-offer",
    );
    expect(dbMocks.deleteLiveForSession).not.toHaveBeenCalled();
  });

  it("returns 400 for an empty WHEP offer", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1", {
        body: "",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("SDP offer is required");
    expect(callsMocks.startPlay).not.toHaveBeenCalled();
  });

  it("rejects whitespace WHEP offers and offers with no Content-Type", async () => {
    const env = createBindings();
    const cookie = await createAuthCookie(env);
    const whitespace = await app.fetch(
      new Request("http://localhost/play/streamer-1", {
        body: "   ",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );
    expect(whitespace.status).toBe(400);
    expect(await whitespace.text()).toBe("SDP offer is required");

    const noContentTypeRequest = new Request(
      "http://localhost/play/streamer-1",
      {
        body: "viewer-offer",
        headers: { Cookie: cookie, Origin: "http://localhost" },
        method: "POST",
      },
    );
    noContentTypeRequest.headers.delete("Content-Type");
    const missingType = await app.fetch(
      noContentTypeRequest,
      env,
      createExecutionContext(),
    );
    expect(missingType.status).toBe(415);
    expect(await missingType.text()).toBe(
      "Content-Type must be application/sdp",
    );
    expect(callsMocks.startPlay).not.toHaveBeenCalled();
  });

  it("returns 204 for GET on the WHEP endpoint", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1", {
        headers: {
          Cookie: await createAuthCookie(env),
        },
        method: "GET",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("returns 204 for GET on the WHEP session resource", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        headers: {
          Cookie: await createAuthCookie(env),
        },
        method: "GET",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("rejects WHEP offers when Content-Type is not application/sdp", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1", {
        body: "viewer-offer",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "text/plain",
          Origin: "http://localhost",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(415);
    expect(await response.text()).toBe("Content-Type must be application/sdp");
    expect(callsMocks.startPlay).not.toHaveBeenCalled();
  });

  it("returns SFU client errors for invalid WHEP offers", async () => {
    const env = createBindings();
    const liveTracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "live-session",
        trackName: "video",
      },
    ];

    dbMocks.getLive.mockResolvedValue({
      sessionId: "live-session",
      tracks: liveTracks,
      userId: "streamer-1",
    });
    callsMocks.startPlay.mockResolvedValue(
      err(
        new SfuApiError("SFU request failed: unprocessable content", {
          endpoint: "/tracks/new",
          kind: "unprocessable_content",
          responseBody: "Malformed SDP offer",
          statusText: "Unprocessable Content",
        }),
      ),
    );

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1", {
        body: "viewer-offer",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toBe("Malformed SDP offer");
  });

  it("checks the live session before starting play", async () => {
    const env = createBindings();
    const consoleInfoSpy = vi
      .spyOn(console, "info")
      .mockImplementation(() => {});
    const liveTracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "live-session",
        trackName: "video",
      },
    ];

    dbMocks.getLive.mockResolvedValue({
      sessionId: "live-session",
      tracks: liveTracks,
      userId: "streamer-1",
    });
    callsMocks.isSessionActive.mockResolvedValue(ok(true));

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1", {
        body: "viewer-offer",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("viewer-answer-sdp");
    expect(response.headers.get("content-type")).toBe("application/sdp");
    expect(response.headers.get("etag")).toBe('"viewer-session"');
    expect(consoleInfoSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "play.request",
        level: "info",
        userId: "viewer-1",
      }),
    );
    expect(callsMocks.isSessionActive).toHaveBeenCalledWith(
      env,
      "live-session",
    );
    expect(callsMocks.startPlay).toHaveBeenCalledWith(
      env,
      "streamer-1",
      liveTracks,
      "viewer-offer",
    );
    expect(response.headers.get("Wish-Live-Track-Count")).toBe("1");
    expect(response.headers.get("access-control-expose-headers")).toBeNull();
    expect(response.headers.get("accept-patch")).toBeNull();
    expect(response.headers.get("location")).toBe(
      "http://localhost/play/streamer-1/viewer-session?mid=0",
    );
  });

  it("returns a WHEP counter-offer with 406", async () => {
    const env = createBindings();
    const liveTracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "live-session",
        trackName: "video",
      },
    ];

    dbMocks.getLive.mockResolvedValue({
      sessionId: "live-session",
      tracks: liveTracks,
      userId: "streamer-1",
    });
    callsMocks.startPlay.mockResolvedValue(
      ok({
        sdpAnswer: "viewer-counter-offer-sdp",
        sessionId: "viewer-session",
        sdpType: "offer",
        tracks: [
          {
            location: "remote",
            mid: "0",
            sessionId: "viewer-session",
            trackName: "video",
          },
        ],
      }),
    );

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1", {
        body: "viewer-offer",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(406);
    expect(await response.text()).toBe("viewer-counter-offer-sdp");
    expect(response.headers.get("Wish-Live-Track-Count")).toBe("1");
    expect(response.headers.get("location")).toBe(
      "http://localhost/play/streamer-1/viewer-session?mid=0",
    );
    expect(response.headers.get("x-session-description-type")).toBeNull();
  });

  it("closes WHEP playback tracks on DELETE", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session?mid=0", {
        headers: {
          Cookie: await createAuthCookie(env),
          Origin: "http://localhost",
        },
        method: "DELETE",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(200);

    expect(execution.waitUntilPromises).toHaveLength(1);

    await Promise.all(execution.waitUntilPromises);

    expect(callsMocks.closeTracks).toHaveBeenCalledWith(env, "viewer-session", [
      {
        location: "remote",
        mid: "0",
        sessionId: "viewer-session",
        trackName: "0",
      },
    ]);
  });

  it("rejects WHEP playback DELETE without track mids", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        headers: {
          Cookie: await createAuthCookie(env),
          Origin: "http://localhost",
        },
        method: "DELETE",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("WHEP session track mids are required");
    expect(callsMocks.closeTracks).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
  });

  it("trims and deduplicates requested WHEP track mids", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();

    const response = await app.fetch(
      new Request(
        "http://localhost/play/streamer-1/viewer-session?mid=%20&mid=0&mid=0&mid=1%20",
        {
          headers: {
            Cookie: await createAuthCookie(env),
            Origin: "http://localhost",
          },
          method: "DELETE",
        },
      ),
      env,
      execution.context,
    );

    expect(response.status).toBe(200);
    await Promise.all(execution.waitUntilPromises);
    expect(callsMocks.closeTracks).toHaveBeenCalledWith(env, "viewer-session", [
      {
        location: "remote",
        mid: "0",
        sessionId: "viewer-session",
        trackName: "0",
      },
      {
        location: "remote",
        mid: "1",
        sessionId: "viewer-session",
        trackName: "1",
      },
    ]);
  });

  it("returns success and logs when WHEP close reports track errors", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const consoleWarnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});

    callsMocks.closeTracks.mockResolvedValue(
      ok({
        tracks: [{ errorCode: "failed_to_close", mid: "0" }],
      }),
    );

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session?mid=0", {
        headers: {
          Cookie: await createAuthCookie(env),
          Origin: "http://localhost",
        },
        method: "DELETE",
      }),
      env,
      execution.context,
    );

    expect(response.status).toBe(200);

    await Promise.all(execution.waitUntilPromises);

    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "track_close.sfu_errors",
        level: "warn",
        message:
          "SFU reported WHEP session close errors for session viewer-session:",
        response: {
          tracks: [{ errorCode: "failed_to_close", mid: "0" }],
        },
        sessionId: "viewer-session",
      }),
    );
  });

  it("returns 400 for an empty renegotiation SDP answer", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        body: "",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "application/sdp",
        },
        method: "PATCH",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("SDP answer is required");
    expect(callsMocks.renegotiateSession).not.toHaveBeenCalled();
  });

  it("rejects WHEP answers when Content-Type is not application/sdp", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        body: "viewer-answer",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "text/plain",
          Origin: "http://localhost",
        },
        method: "PATCH",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(415);
    expect(await response.text()).toBe("Content-Type must be application/sdp");
    expect(callsMocks.renegotiateSession).not.toHaveBeenCalled();
  });

  it("returns SFU client errors for invalid WHEP answers", async () => {
    const env = createBindings();

    callsMocks.renegotiateSession.mockResolvedValue(
      err(
        new SfuApiError("SFU request failed: unprocessable content", {
          endpoint: "/renegotiate",
          kind: "unprocessable_content",
          responseBody: "Malformed SDP answer",
          statusText: "Unprocessable Content",
        }),
      ),
    );

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        body: "viewer-answer",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "application/sdp",
        },
        method: "PATCH",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toBe("Malformed SDP answer");
  });

  it("returns 204 after successful WHEP renegotiation", async () => {
    const env = createBindings();

    callsMocks.renegotiateSession.mockResolvedValue(
      ok(new Response(null, { status: 200 })),
    );

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        body: "viewer-answer",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "application/sdp",
        },
        method: "PATCH",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(204);
    expect(callsMocks.renegotiateSession).toHaveBeenCalledWith(
      env,
      "viewer-session",
      "viewer-answer",
    );
  });

  it("rejects whitespace-only WHEP answers before renegotiation", async () => {
    const env = createBindings();
    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        body: " \n\t ",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "application/sdp",
        },
        method: "PATCH",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("SDP answer is required");
    expect(callsMocks.renegotiateSession).not.toHaveBeenCalled();
  });

  it("logs non-SFU WHEP answer errors and returns 502", async () => {
    const env = createBindings();
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    callsMocks.renegotiateSession.mockResolvedValue(
      err(
        new SfuApiError("unexpected renegotiation error", {
          endpoint: "/renegotiate",
          kind: "request_failed",
        }),
      ),
    );

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        body: "viewer-answer",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "application/sdp",
        },
        method: "PATCH",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to submit WHEP answer");
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "unexpected renegotiation error",
        event: "play.answer_submission_failed",
        level: "error",
        sessionId: "viewer-session",
      }),
    );
  });
});
