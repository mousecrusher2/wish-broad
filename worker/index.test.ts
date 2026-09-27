import { sign } from "hono/jwt";
import { err, ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      new Request("http://localhost/login"),
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

  it("issues an auth cookie after a successful Discord login", async () => {
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
  });

  it.each([
    ["Channel Nick", "Global Name", "user_name", "Channel Nick"],
    [null, "Global Name", "user_name", "Global Name"],
    [null, null, "user_name", "user_name"],
  ] as const)(
    "chooses the Discord display name from nick=%s global=%s",
    async (nick, globalName, username, expected) => {
      const env = createBindings();
      discordMocks.getGuildMember.mockResolvedValue(
        ok({
          nick,
          user: { id: "user-1", username, global_name: globalName },
        }),
      );
      const response = await app.fetch(
        new Request("http://localhost/login/callback?code=code&state=s", {
          headers: { Cookie: "discord_oauth_state=s" },
        }),
        env,
        createExecutionContext(),
      );
      expect(response.status).toBe(302);
      expect(dbMocks.setUser).toHaveBeenCalledWith(env.LIVE_DB, {
        userId: "user-1",
        displayName: expected,
      });
    },
  );

  it("sets the login cookie expiration one day in the future", async () => {
    const now = Date.now();
    const response = await app.fetch(
      new Request("http://localhost/login/callback?code=code&state=s", {
        headers: { Cookie: "discord_oauth_state=s" },
      }),
      createBindings(),
      createExecutionContext(),
    );
    const cookie = response.headers.get("set-cookie") ?? "";
    const expiration = /Expires=([^;]+)/iu.exec(cookie)?.[1];
    expect(expiration).toBeDefined();
    const remainingMs = Date.parse(expiration ?? "") - now;
    expect(remainingMs).toBeGreaterThan(86_399_000);
    expect(remainingMs).toBeLessThanOrEqual(86_400_000);
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
  });

  it("uses secure state and auth cookies in production and clears both on logout", async () => {
    const env = createBindings();
    const started = await app.fetch(
      new Request("https://wish.test/login?ignored=1#fragment"),
      env,
      createExecutionContext(),
    );
    const stateCookie = started.headers.get("set-cookie");
    expect(stateCookie).toContain("Path=/login");
    expect(stateCookie).toContain("SameSite=Lax");
    expect(stateCookie).toContain("HttpOnly");
    expect(stateCookie).toContain("Secure");
    expect(stateCookie).toContain("Max-Age=600");
    expect(discordMocks.buildDiscordAuthorizationUrl).toHaveBeenCalledWith(
      env,
      "https://wish.test/login/callback",
      "oauth-state",
    );

    const completed = await app.fetch(
      new Request(
        "https://wish.test/login/callback?code=code&state=oauth-state",
        {
          headers: { Cookie: "discord_oauth_state=oauth-state" },
        },
      ),
      env,
      createExecutionContext(),
    );
    const cookies = completed.headers.getSetCookie();
    expect(cookies).toEqual([
      expect.stringContaining("discord_oauth_state="),
      expect.stringContaining("authtoken="),
    ]);
    expect(cookies[0]).toContain("Path=/login");
    expect(cookies[0]).toContain("Secure");
    expect(cookies[1]).toContain("HttpOnly");
    expect(cookies[1]).toContain("SameSite=Strict");
    expect(cookies[1]).toContain("Secure");
    const loggedOut = await app.fetch(
      new Request("https://wish.test/logout", {
        method: "POST",
        headers: { Origin: "https://wish.test" },
      }),
      env,
      createExecutionContext(),
    );
    expect(loggedOut.headers.get("set-cookie")).toContain("Secure");
  });

  it.each([
    [
      "http://localhost/login/callback?code=code&state=s",
      undefined,
      "Invalid OAuth state",
      400,
    ],
    [
      "http://localhost/login/callback?code=code",
      "discord_oauth_state=s",
      "Invalid OAuth state",
      400,
    ],
    [
      "http://localhost/login/callback?code=code&state=wrong",
      "discord_oauth_state=s",
      "Invalid OAuth state",
      400,
    ],
    [
      "http://localhost/login/callback?error=access_denied&state=s",
      "discord_oauth_state=s",
      "Discord authorization failed: access_denied",
      401,
    ],
    [
      "http://localhost/login/callback?error=access_denied&error_description=Denied&state=s",
      "discord_oauth_state=s",
      "Discord authorization failed: Denied",
      401,
    ],
    [
      "http://localhost/login/callback?state=s",
      "discord_oauth_state=s",
      "Authorization code is required",
      400,
    ],
  ])("validates OAuth callback %s", async (url, cookie, body, status) => {
    const response = await app.fetch(
      new Request(url, cookie ? { headers: { Cookie: cookie } } : {}),
      createBindings(),
      createExecutionContext(),
    );
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("set-cookie")).toContain(
      "discord_oauth_state=",
    );
    expect(discordMocks.exchangeCodeForToken).not.toHaveBeenCalled();
  });

  it("reports token exchange errors without looking up the member", async () => {
    const env = createBindings();
    discordMocks.exchangeCodeForToken.mockResolvedValue(
      err(
        new discordMocks.DiscordApiError("bad token", {
          endpoint: "https://discord.com/api/oauth2/token",
          kind: "http_error",
        }),
      ),
    );
    discordMocks.getDiscordErrorMessage.mockReturnValue("OAuth unavailable");
    const response = await app.fetch(
      new Request("http://localhost/login/callback?code=code&state=s", {
        headers: { Cookie: "discord_oauth_state=s" },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      "Discord login failed: OAuth unavailable",
    );
    expect(discordMocks.getGuildMember).not.toHaveBeenCalled();
    expect(discordMocks.revokeAccessToken).not.toHaveBeenCalled();
  });

  it.each(["unauthorized", "forbidden", "not_found"] as const)(
    "treats guild membership %s as unauthorized",
    async (kind) => {
      const env = createBindings();
      discordMocks.getGuildMember.mockResolvedValue(
        err(
          new discordMocks.DiscordApiError("no membership", {
            endpoint: `https://discord.com/api/v10/users/@me/guilds/${env.AUTHORIZED_GUILD_ID}/member`,
            kind,
          }),
        ),
      );
      const response = await app.fetch(
        new Request("http://localhost/login/callback?code=code&state=s", {
          headers: { Cookie: "discord_oauth_state=s" },
        }),
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
    },
  );

  it("reports unrelated Discord member failures as upstream errors and revokes the token", async () => {
    const env = createBindings();
    discordMocks.getGuildMember.mockResolvedValue(
      err(
        new discordMocks.DiscordApiError("service error", {
          endpoint: "https://discord.com/api/v10/users/@me",
          kind: "not_found",
        }),
      ),
    );
    discordMocks.getDiscordErrorMessage.mockReturnValue("Service unavailable");
    discordMocks.revokeAccessToken.mockResolvedValue(
      err(new Error("revoke failed")),
    );
    const response = await app.fetch(
      new Request("http://localhost/login/callback?code=code&state=s", {
        headers: { Cookie: "discord_oauth_state=s" },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      "Discord login failed: Service unavailable",
    );
    expect(discordMocks.revokeAccessToken).toHaveBeenCalledOnce();
  });

  it.each([
    [
      {
        nick: "Nickname",
        user: { id: "u", global_name: "Global", username: "Username" },
      },
      "Nickname",
    ],
    [
      {
        nick: null,
        user: { id: "u", global_name: null, username: "Username" },
      },
      "Username",
    ],
  ])("selects the Discord member display name", async (member, name) => {
    const env = createBindings();
    discordMocks.getGuildMember.mockResolvedValue(ok(member));
    const response = await app.fetch(
      new Request("http://localhost/login/callback?code=code&state=s", {
        headers: { Cookie: "discord_oauth_state=s" },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(302);
    expect(dbMocks.setUser).toHaveBeenCalledWith(env.LIVE_DB, {
      userId: "u",
      displayName: name,
    });
  });

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

  it.each(["/api/me", "/play/streamer-1"])(
    "rejects unauthenticated access to %s",
    async (path) => {
      const env = createBindings();
      const errorLog = vi.spyOn(console, "error");
      const response = await app.fetch(
        new Request(`http://localhost${path}`),
        env,
        createExecutionContext(),
      );
      expect(response.status).toBe(401);
      expect(errorLog).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "worker.unhandled_error" }),
      );
    },
  );

  it("returns the authenticated user's identity without exposing the JWT", async () => {
    const env = createBindings();
    const response = await app.fetch(
      new Request("http://localhost/api/me", {
        headers: {
          Cookie: await createAuthCookie(env, {
            userId: "viewer-42",
            displayName: "Viewer Name",
          }),
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId: "viewer-42",
      displayName: "Viewer Name",
    });
  });

  it.each([true, false])(
    "returns live-token status %s without revealing the token",
    async (hasToken) => {
      const env = createBindings();
      dbMocks.hasLiveToken.mockResolvedValue(hasToken);
      const response = await app.fetch(
        new Request("http://localhost/api/me/livetoken", {
          headers: {
            Cookie: await createAuthCookie(env, { userId: "viewer-42" }),
          },
        }),
        env,
        createExecutionContext(),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ hasToken });
      expect(dbMocks.hasLiveToken).toHaveBeenCalledExactlyOnceWith(
        env.LIVE_DB,
        "viewer-42",
      );
    },
  );

  it("reports a failed live-token status lookup", async () => {
    const env = createBindings();
    dbMocks.hasLiveToken.mockRejectedValue(new Error("database unavailable"));
    const response = await app.fetch(
      new Request("http://localhost/api/me/livetoken", {
        headers: { Cookie: await createAuthCookie(env) },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Failed to check live token");
  });

  it("reports a failed live-token save without returning a credential", async () => {
    const env = createBindings();
    dbMocks.setLiveToken.mockRejectedValue(new Error("database unavailable"));
    const response = await app.fetch(
      new Request("http://localhost/api/me/livetoken", {
        method: "POST",
        headers: {
          Cookie: await createAuthCookie(env),
          Origin: "http://localhost",
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Failed to save live token");
    expect(dbMocks.setLiveToken).toHaveBeenCalledOnce();
  });

  it("returns all live streams as a JSON array", async () => {
    const env = createBindings();
    const rows = [{ owner: { userId: "u", displayName: "User" } }];
    dbMocks.getAllLives.mockResolvedValue(rows);
    const response = await app.fetch(
      new Request("http://localhost/api/lives", {
        headers: { Cookie: await createAuthCookie(env) },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(rows);
    expect(dbMocks.getAllLives).toHaveBeenCalledExactlyOnceWith(env.LIVE_DB);
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
  });

  it("logs failed cleanup of a stale stream notification without blocking ingest", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const warning = vi.spyOn(console, "warn");
    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 9n,
      sessionId: "stale-session",
      tracks: [],
      userId: "user-1",
    });
    callsMocks.isSessionActive.mockResolvedValue(ok(false));
    notificationsMocks.deleteLiveStartedNotification.mockResolvedValue(
      err(new Error("Discord offline")),
    );
    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1?notify=0", {
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
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "live_notification.delete_failed",
        errorMessage: "Discord offline",
        messageId: 9n,
        sessionId: "stale-session",
        userId: "user-1",
      }),
    );
  });

  it("schedules the live start notification via waitUntil", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();

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
  });

  it.each(["false", "0"])(
    "does not notify Discord when notify=%s",
    async (notify) => {
      const env = createBindings();
      const execution = createObservedExecutionContext();
      const response = await app.fetch(
        new Request(
          `https://wish-broad.example/ingest/user-1?notify=${notify}`,
          {
            body: "offer-sdp",
            headers: {
              Authorization: "Bearer live-token",
              "Content-Type": "application/sdp",
            },
            method: "POST",
          },
        ),
        env,
        execution.context,
      );

      expect(response.status).toBe(201);
      expect(await response.text()).toBe("answer-sdp");
      expect(dbMocks.insertLive).toHaveBeenCalledOnce();
      expect(execution.waitUntilPromises).toHaveLength(0);
      expect(
        notificationsMocks.sendLiveStartedNotification,
      ).not.toHaveBeenCalled();
    },
  );

  it.each([
    [" APPLICATION/SDP ; charset=utf-8", 201],
    ["application/sdp; charset=utf-8", 201],
    ["application/sdpish", 415],
    ["text/plain; application/sdp", 415],
  ] as const)(
    "validates the SDP media type %s",
    async (contentType, status) => {
      const env = createBindings();
      const execution = createObservedExecutionContext();
      const response = await app.fetch(
        new Request("https://wish-broad.example/ingest/user-1?notify=0", {
          body: "offer-sdp",
          headers: {
            Authorization: "Bearer live-token",
            "Content-Type": contentType,
          },
          method: "POST",
        }),
        env,
        execution.context,
      );
      expect(response.status).toBe(status);
      expect(callsMocks.startIngest).toHaveBeenCalledTimes(
        status === 201 ? 1 : 0,
      );
      if (status === 201) {
        expect(await response.text()).toBe("answer-sdp");
      } else {
        expect(await response.text()).toBe(
          "Content-Type must be application/sdp",
        );
      }
    },
  );

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

  it("rejects ingest when Content-Type is absent", async () => {
    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        headers: { Authorization: "Bearer live-token" },
        method: "POST",
      }),
      createBindings(),
      createExecutionContext(),
    );
    expect(response.status).toBe(415);
    expect(await response.text()).toBe("Content-Type must be application/sdp");
    expect(callsMocks.startIngest).not.toHaveBeenCalled();
  });

  it("rejects an ingest request with a missing SDP body", async () => {
    const env = createBindings();
    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("SDP offer is required");
    expect(callsMocks.startIngest).not.toHaveBeenCalled();
  });

  it("rejects an ingest request with whitespace-only SDP", async () => {
    const env = createBindings();
    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        body: "  \n ",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("SDP offer is required");
    expect(callsMocks.startIngest).not.toHaveBeenCalled();
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
    const warning = vi.spyOn(console, "warn");
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
    expect(dbMocks.deleteLiveForSession).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      "session-1",
    );
    expect(execution.waitUntilPromises).toHaveLength(2);

    await Promise.all(execution.waitUntilPromises);

    expect(warning).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "track_close.sfu_errors" }),
    );

    expect(callsMocks.closeTracks).toHaveBeenCalledWith(
      env,
      "session-1",
      tracks,
    );
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).toHaveBeenCalledWith(env, 1n);
  });

  it("warns when only one of several publisher tracks fails to close", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const warning = vi.spyOn(console, "warn");
    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: null,
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
          mid: "1",
          sessionId: "session-1",
          trackName: "audio",
        },
      ],
      userId: "user-1",
    });
    callsMocks.closeTracks.mockResolvedValue(
      ok({
        tracks: [{ mid: "0" }, { mid: "1", errorCode: "failed_to_close" }],
      }),
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
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "track_close.sfu_errors",
        sessionId: "session-1",
      }),
    );
  });

  it("logs a failed notification deletion after removing an ingest session", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const warning = vi.spyOn(console, "warn");
    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: 7n,
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
      err(new Error("Discord offline")),
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
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "live_notification.delete_failed",
        errorMessage: "Discord offline",
        messageId: 7n,
        sessionId: "session-1",
        userId: "user-1",
      }),
    );
  });

  it.each([
    { tracks: [{ errorCode: "failed_to_close", mid: "0" }] },
    { errorCode: "failed_to_close" },
  ])(
    "returns success and logs when ingest close reports %s",
    async (closeResponse) => {
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
      callsMocks.closeTracks.mockResolvedValue(ok(closeResponse));

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
          response: closeResponse,
          sessionId: "session-1",
        }),
      );
      expect(
        notificationsMocks.deleteLiveStartedNotification,
      ).toHaveBeenCalledWith(env, 1n);
    },
  );

  it("logs a Calls transport failure after removing a live session", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const warning = vi.spyOn(console, "warn");
    dbMocks.getLive.mockResolvedValue({
      notificationMessageId: null,
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
        new SfuApiError("Calls offline", {
          endpoint: "/tracks/close",
          kind: "request_failed",
          statusText: "Unavailable",
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
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(warning).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "track_close.failed",
        errorKind: "request_failed",
        errorMessage: "Calls offline",
        message: "Failed to close live tracks for user user-1:",
        sessionId: "session-1",
      }),
    );
  });

  it.each(["session_not_found", "session_gone"] as const)(
    "returns success when ingest close reports %s",
    async (kind) => {
      const env = createBindings();
      const execution = createObservedExecutionContext();
      const warning = vi.spyOn(console, "warn");

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
            kind,
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

      expect(warning).not.toHaveBeenCalledWith(
        expect.objectContaining({ event: "track_close.failed" }),
      );

      expect(
        notificationsMocks.deleteLiveStartedNotification,
      ).toHaveBeenCalledWith(env, 1n);
    },
  );

  it("rejects ingest deletion when no stream exists", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    dbMocks.getLive.mockResolvedValue(null);
    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: { Authorization: "Bearer live-token" },
        method: "DELETE",
      }),
      env,
      execution.context,
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("No live stream found for this user");
    expect(dbMocks.deleteLiveForSession).not.toHaveBeenCalled();
    expect(callsMocks.closeTracks).not.toHaveBeenCalled();
    expect(execution.waitUntilPromises).toHaveLength(0);
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

  it.each(["inactive", "missing_during_play"] as const)(
    "logs failed notification cleanup when playback is %s",
    async (reason) => {
      const env = createBindings();
      const execution = createObservedExecutionContext();
      const warning = vi.spyOn(console, "warn");
      dbMocks.getLive.mockResolvedValue({
        notificationMessageId: 11n,
        sessionId: "live-session",
        tracks: [
          {
            location: "remote",
            mid: "0",
            sessionId: "live-session",
            trackName: "video",
          },
        ],
        userId: "streamer-1",
      });
      notificationsMocks.deleteLiveStartedNotification.mockResolvedValue(
        err(new Error("Discord offline")),
      );
      if (reason === "inactive") {
        callsMocks.isSessionActive.mockResolvedValue(ok(false));
      } else {
        callsMocks.startPlay.mockResolvedValue(
          err(
            new SfuApiError("gone", {
              endpoint: "/tracks/new",
              kind: "session_not_found",
            }),
          ),
        );
      }
      const response = await requestPlayOffer(env, execution.context);
      expect(response.status).toBe(404);
      await Promise.all(execution.waitUntilPromises);
      expect(warning).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "live_notification.delete_failed",
          errorMessage: "Discord offline",
          messageId: 11n,
          sessionId: "live-session",
          userId: "streamer-1",
        }),
      );
    },
  );

  it.each(["", "   "])(
    "returns 400 for an empty WHEP offer %s",
    async (body) => {
      const env = createBindings();

      const response = await app.fetch(
        new Request("http://localhost/play/streamer-1", {
          body,
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
    },
  );

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

  it.each(["", "   "])(
    "returns 400 for an empty renegotiation SDP answer %s",
    async (body) => {
      const env = createBindings();

      const response = await app.fetch(
        new Request("http://localhost/play/streamer-1/viewer-session", {
          body,
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
    },
  );

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

  it("deduplicates and trims WHEP session mids before closing tracks", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    const response = await app.fetch(
      new Request(
        "http://localhost/play/user/viewer-session?mid=%200%20&mid=0&mid=1&mid=%20",
        {
          method: "DELETE",
          headers: {
            Cookie: await createAuthCookie(env),
            Origin: "http://localhost",
          },
        },
      ),
      env,
      execution.context,
    );
    expect(response.status).toBe(200);
    await Promise.all(execution.waitUntilPromises);
    expect(callsMocks.closeTracks).toHaveBeenCalledExactlyOnceWith(
      env,
      "viewer-session",
      [
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
      ],
    );
  });

  it("reports a missing playback resource from the SFU without creating a session", async () => {
    const env = createBindings();
    dbMocks.getLive.mockResolvedValue({
      userId: "streamer-1",
      sessionId: "live-session",
      tracks: [
        {
          location: "remote",
          mid: "0",
          sessionId: "live-session",
          trackName: "video",
        },
      ],
    });
    callsMocks.startPlay.mockResolvedValue(
      err(new LiveNotFoundError("streamer-1")),
    );
    const response = await requestPlayOffer(env);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Live stream not found: streamer-1");
  });

  it("maps SFU playback service failure to a server error", async () => {
    const env = createBindings();
    dbMocks.getLive.mockResolvedValue({
      userId: "streamer-1",
      sessionId: "live-session",
      tracks: [
        {
          location: "remote",
          mid: "0",
          sessionId: "live-session",
          trackName: "video",
        },
      ],
    });
    callsMocks.startPlay.mockResolvedValue(
      err(
        new SfuApiError("unavailable", {
          endpoint: "/tracks/new",
          kind: "http_error",
          statusText: "Bad Gateway",
        }),
      ),
    );
    const response = await requestPlayOffer(env);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to negotiate playback session");
    expect(dbMocks.deleteLiveForSession).not.toHaveBeenCalled();
  });

  it("maps SFU renegotiation service failure to a server error", async () => {
    const env = createBindings();
    callsMocks.renegotiateSession.mockResolvedValue(
      err(
        new SfuApiError("unavailable", {
          endpoint: "/renegotiate",
          kind: "http_error",
          statusText: "Bad Gateway",
        }),
      ),
    );
    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        method: "PATCH",
        body: "viewer-answer",
        headers: {
          Cookie: await createAuthCookie(env),
          "Content-Type": "application/sdp",
          Origin: "http://localhost",
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to submit WHEP answer");
  });

  it("reports a failed activity check before replacing an existing ingest", async () => {
    const env = createBindings();
    dbMocks.getLive.mockResolvedValue({
      userId: "user-1",
      sessionId: "old-session",
      tracks: [],
    });
    callsMocks.isSessionActive.mockResolvedValue(
      err(new Error("upstream down")),
    );
    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        method: "POST",
        body: "offer",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
      }),
      env,
      createExecutionContext(),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      "Failed to verify ingest session status",
    );
    expect(callsMocks.startIngest).not.toHaveBeenCalled();
    expect(dbMocks.deleteLiveForSession).not.toHaveBeenCalled();
  });

  it("reports a failed activity check before starting playback", async () => {
    const env = createBindings();
    dbMocks.getLive.mockResolvedValue({
      userId: "streamer-1",
      sessionId: "live-session",
      tracks: [],
    });
    callsMocks.isSessionActive.mockResolvedValue(
      err(new Error("upstream down")),
    );
    const response = await requestPlayOffer(env);
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to verify live stream status");
    expect(callsMocks.startPlay).not.toHaveBeenCalled();
  });

  it("cleans up an orphan notification when persistence rejects and logs failed deletion", async () => {
    const env = createBindings();
    const execution = createObservedExecutionContext();
    dbMocks.setLiveNotificationMessageId.mockRejectedValue(
      new Error("database lost"),
    );
    notificationsMocks.deleteLiveStartedNotification.mockResolvedValue(
      err(new Error("webhook gone")),
    );
    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1", {
        method: "POST",
        body: "offer",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
      }),
      env,
      execution.context,
    );
    expect(response.status).toBe(201);
    await Promise.all(execution.waitUntilPromises);
    expect(
      notificationsMocks.deleteLiveStartedNotification,
    ).toHaveBeenCalledWith(env, 1n);
    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "live_notification.persist_failed",
        errorMessage: "database lost",
        messageId: 1n,
        sessionId: "new-session",
        userId: "user-1",
      }),
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "live_notification.orphan_delete_failed",
        errorMessage: "webhook gone",
        messageId: 1n,
        sessionId: "new-session",
        userId: "user-1",
      }),
    );
  });
});
