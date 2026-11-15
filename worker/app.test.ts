import {
  createExecutionContext,
  reset,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sign, verify } from "hono/jwt";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  DiscordApiError,
  type DiscordGuildMember,
  type DiscordOAuthToken,
} from "./clients/discord-oauth";
import { LiveEffects } from "./live/effects";
import { getLiveState, LiveState } from "./state/live-state";
import { LiveNotFoundError, SfuApiError } from "./clients/sfu";
import type { StoredTrack } from "./live/types";
import { hashTokenWithPepper } from "./lib/token-hash";
import { TurnApiError } from "./clients/turn";
import type { Bindings } from "./types";

// 外部 API ラッパー（SFU、Discord OAuth、Discord Webhook、TURN）は各モジュールのテストで
// HTTP レベルまで検証しているため、ここではルートとの境界で差し替える。LiveState は
// 実際の Durable Object をそのまま使う。
const sfuMocks = vi.hoisted(() => ({
  closeTracks: vi.fn<() => Promise<unknown>>(),
  isSessionActive: vi.fn<() => Promise<boolean>>(),
  renegotiateSession: vi.fn<() => Promise<unknown>>(),
  startIngest: vi.fn<() => Promise<unknown>>(),
  startPlay: vi.fn<() => Promise<unknown>>(),
}));

const notificationsMocks = vi.hoisted(() => ({
  sendLiveStartedNotification: vi.fn<() => Promise<unknown>>(),
}));

const turnMocks = vi.hoisted(() => ({
  generateTurnIceServers: vi.fn<() => Promise<unknown>>(),
}));

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

vi.mock("./clients/sfu", async () => ({
  ...(await vi.importActual<typeof import("./clients/sfu")>("./clients/sfu")),
  ...sfuMocks,
}));
vi.mock("./clients/discord-oauth", async () => ({
  ...(await vi.importActual<typeof import("./clients/discord-oauth")>(
    "./clients/discord-oauth",
  )),
  ...discordMocks,
}));
vi.mock("./clients/discord-webhook", async () => ({
  ...(await vi.importActual<typeof import("./clients/discord-webhook")>(
    "./clients/discord-webhook",
  )),
  ...notificationsMocks,
}));
vi.mock("./clients/turn", async () => ({
  ...(await vi.importActual<typeof import("./clients/turn")>("./clients/turn")),
  ...turnMocks,
}));

import app from "./app";

/** 実際のアラームが自動発火しないよう、テストの時計は遠い未来に置く。 */
const NOW = Date.UTC(2100, 0, 1);

function createTracks(sessionId: string): StoredTrack[] {
  return [
    {
      location: "remote",
      mid: "0",
      sessionId,
      trackName: "video",
    },
  ];
}

const INGEST_SESSION = {
  sdpAnswer: "answer-sdp",
  sessionId: "new-session",
  tracks: createTracks("new-session"),
};

async function createAuthCookie(
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

async function fetchApp(
  request: Request,
  executionContext = createExecutionContext(),
  bindings: Bindings = env,
): Promise<Response> {
  return app.fetch(request, bindings, executionContext);
}

async function requestPlayOffer(
  executionContext = createExecutionContext(),
): Promise<Response> {
  return fetchApp(
    new Request("http://localhost/play/streamer-1", {
      body: "viewer-offer",
      headers: {
        Cookie: await createAuthCookie(),
        "Content-Type": "application/sdp",
      },
      method: "POST",
    }),
    executionContext,
  );
}

async function requestLiveTokenStatus(userId: string): Promise<Response> {
  return fetchApp(
    new Request("http://localhost/api/me/livetoken", {
      headers: { Cookie: await createAuthCookie({ userId }) },
    }),
  );
}

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

async function requestIngestOffer(
  executionContext = createExecutionContext(),
  query = "",
): Promise<Response> {
  return fetchApp(
    new Request(`http://localhost/ingest/user-1${query}`, {
      body: "offer-sdp",
      headers: {
        Authorization: "Bearer live-token",
        "Content-Type": "application/sdp",
      },
      method: "POST",
    }),
    executionContext,
  );
}

async function requestIngestDelete(
  executionContext = createExecutionContext(),
  sessionId = "session-1",
): Promise<Response> {
  return fetchApp(
    new Request(`http://localhost/ingest/user-1/${sessionId}`, {
      headers: { Authorization: "Bearer live-token" },
      method: "DELETE",
    }),
    executionContext,
  );
}

/**
 * 公開されている LiveState のメソッドだけを使って配信を開始した状態を作り、
 * その配信 ID を返す。各時刻はテストの現在時刻からの相対値で指定する。
 */
async function seedLive({
  graceMs,
  notificationMessageId,
  sessionId = "session-1",
  sessionSeenActiveAt,
  tracks = createTracks(sessionId),
  userId = "user-1",
}: {
  graceMs?: number;
  notificationMessageId?: string;
  sessionId?: string;
  sessionSeenActiveAt?: number;
  tracks?: StoredTrack[];
  userId?: string;
} = {}): Promise<string> {
  const liveState = getLiveState(env);
  const broadcastId = await liveState.insertLive(userId, sessionId, tracks);
  assert.isNotNull(broadcastId, "Expected a new broadcast");
  if (notificationMessageId !== undefined) {
    await liveState.setLiveNotificationMessageId(
      userId,
      broadcastId,
      notificationMessageId,
    );
  }
  if (sessionSeenActiveAt !== undefined) {
    // LiveState は自身の時計で記録するため、記録時刻まで時計を戻してから記録させる。
    const now = Date.now();
    vi.setSystemTime(sessionSeenActiveAt);
    await liveState.markLiveSessionSeenActive(userId, sessionId, 0);
    vi.setSystemTime(now);
  }
  if (graceMs !== undefined) {
    await liveState.startLiveReconnectGrace(userId, sessionId, graceMs);
  }
  return broadcastId;
}

async function getLive(userId = "user-1") {
  return getLiveState(env).getLive(userId);
}

/** 配信行に保存されている開始通知のメッセージ ID。 */
async function getStoredNotificationMessageId(
  userId = "user-1",
): Promise<SqlStorageValue> {
  return runInDurableObject(
    getLiveState(env),
    (_instance, state) =>
      state.storage.sql
        .exec(
          "SELECT notification_message_id FROM lives WHERE user_id = ?",
          userId,
        )
        .toArray()[0]?.["notification_message_id"] ?? null,
  );
}

async function getStoredUsers(): Promise<Record<string, SqlStorageValue>[]> {
  return runInDurableObject(getLiveState(env), (_instance, state) =>
    state.storage.sql
      .exec("SELECT user_id, display_name FROM users ORDER BY user_id")
      .toArray(),
  );
}

async function getLiveStateAlarm(): Promise<number | null> {
  return runInDurableObject(getLiveState(env), async (_instance, state) =>
    state.storage.getAlarm(),
  );
}

/**
 * ルートが LiveState から配信行を読んだ直後に別の処理を割り込ませ、Worker が行う
 * 2 つのオブジェクト呼び出しの間に競合するリクエストが状態を変えた（または時計が進んだ）
 * 状況を再現する。
 */
function interleaveAfterNextGetLive(
  interleaved: (liveState: LiveState) => Promise<unknown> | undefined,
): void {
  // oxlint-disable-next-line typescript/unbound-method -- 元の実装をスパイの中から呼び出すため。
  const { getLive: readLive } = LiveState.prototype;
  vi.spyOn(LiveState.prototype, "getLive").mockImplementationOnce(
    async function (this: LiveState, userId: string) {
      const live = await readLive.call(this, userId);
      await interleaved(this);
      return live;
    },
  );
}

describe("worker app", () => {
  // テストランナーの console はアクセスのたびに別の関数を返すため、スパイは戻り値で参照する。
  let consoleError: MockInstance<Console["error"]>;
  let consoleInfo: MockInstance<Console["info"]>;
  let consoleWarn: MockInstance<Console["warn"]>;
  /** LiveState が開始通知の削除を引き渡す先。削除そのものは ./live/effects.test.ts で検証する。 */
  let dispatch: MockInstance<LiveEffects["deleteStartNotifications"]>;

  beforeEach(async () => {
    vi.setSystemTime(NOW);
    dispatch = vi
      .spyOn(LiveEffects.prototype, "deleteStartNotifications")
      .mockImplementation(() => undefined);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (const mock of [
      ...Object.values(sfuMocks),
      ...Object.values(discordMocks),
      ...Object.values(notificationsMocks),
      ...Object.values(turnMocks),
    ]) {
      mock.mockReset();
    }

    // user-1 は配信トークン "live-token" を発行済み。
    await getLiveState(env).setLiveToken(
      "user-1",
      await hashTokenWithPepper(env.LIVE_TOKEN_PEPPER, "live-token"),
    );

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

    sfuMocks.closeTracks.mockResolvedValue({});
    sfuMocks.isSessionActive.mockResolvedValue(true);
    sfuMocks.renegotiateSession.mockResolvedValue(undefined);
    sfuMocks.startIngest.mockResolvedValue(INGEST_SESSION);
    sfuMocks.startPlay.mockResolvedValue({
      sdpAnswer: "viewer-answer-sdp",
      sessionId: "viewer-session",
      sdpType: "answer",
      tracks: createTracks("viewer-session"),
    });
    notificationsMocks.sendLiveStartedNotification.mockResolvedValue({
      messageId: 1n,
    });
    turnMocks.generateTurnIceServers.mockResolvedValue([
      {
        urls: ["stun:stun.cloudflare.com:3478"],
      },
    ]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await reset();
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
    expect(consoleError).toHaveBeenCalledWith(
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
    expect(consoleWarn).not.toHaveBeenCalled();
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
    expect(consoleWarn).toHaveBeenCalledWith(
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
    expect(consoleError).toHaveBeenCalledWith(
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

  it("issues a live token for an authenticated user", async () => {
    const response = await fetchApp(
      new Request("http://localhost/api/me/livetoken", {
        headers: {
          Cookie: await createAuthCookie({ userId: "user-2" }),
          Origin: "http://localhost",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);

    const body: {
      success: boolean;
      token: string;
    } = await response.json();

    expect(body.success).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/u);
    await expect(getLiveState(env).getLiveTokenHash("user-2")).resolves.toBe(
      await hashTokenWithPepper(env.LIVE_TOKEN_PEPPER, body.token),
    );
  });

  it("returns a worker error when saving a new live token fails", async () => {
    vi.spyOn(LiveState.prototype, "setLiveToken").mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await fetchApp(
      new Request("http://localhost/api/me/livetoken", {
        headers: {
          Cookie: await createAuthCookie({ userId: "user-2" }),
          Origin: "http://localhost",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Failed to save live token");
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "database unavailable",
        event: "live_token.save_failed",
        level: "error",
        userId: "user-2",
      }),
    );
    await expect(getLiveState(env).hasLiveToken("user-2")).resolves.toBe(false);
  });

  it("returns live-token status and maps database failures to 500", async () => {
    const issued = await requestLiveTokenStatus("user-1");
    expect(issued.status).toBe(200);
    await expect(issued.json()).resolves.toEqual({ hasToken: true });
    const missing = await requestLiveTokenStatus("user-2");
    await expect(missing.json()).resolves.toEqual({ hasToken: false });

    vi.spyOn(LiveState.prototype, "hasLiveToken").mockRejectedValue(
      new Error("database unavailable"),
    );
    const failed = await requestLiveTokenStatus("user-1");
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("Failed to check live token");
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "database unavailable",
        event: "live_token.status_check_failed",
        level: "error",
        userId: "user-1",
      }),
    );
  });

  it("lists stored live streams for an authenticated app user", async () => {
    await getLiveState(env).setUser({
      displayName: "Streamer",
      userId: "streamer-1",
    });
    await seedLive({ userId: "streamer-1" });

    const response = await fetchApp(
      new Request("http://localhost/api/lives", {
        headers: { Cookie: await createAuthCookie() },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { owner: { displayName: "Streamer", userId: "streamer-1" } },
    ]);
  });

  it("logs unexpected errors from API handlers and returns a generic response", async () => {
    vi.spyOn(LiveState.prototype, "getAllLives").mockRejectedValue(
      new Error("database offline"),
    );

    const response = await fetchApp(
      new Request("http://localhost/api/lives", {
        headers: { Cookie: await createAuthCookie() },
      }),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "database offline",
        event: "worker.unhandled_error",
        level: "error",
      }),
    );
  });

  it("returns the authenticated profile payload", async () => {
    const response = await fetchApp(
      new Request("http://localhost/api/me", {
        headers: {
          Cookie: await createAuthCookie({
            displayName: "Viewer Name",
            userId: "viewer-7",
          }),
        },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      displayName: "Viewer Name",
      userId: "viewer-7",
    });
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "api.request",
        level: "info",
        userId: "viewer-7",
      }),
    );
  });

  it("returns authenticated TURN credentials with no-store caching", async () => {
    const response = await fetchApp(
      new Request("http://localhost/api/turn-credentials", {
        headers: {
          Cookie: await createAuthCookie({ userId: "viewer-1" }),
        },
      }),
    );

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
    turnMocks.generateTurnIceServers.mockRejectedValue(
      new TurnApiError("TURN credential request timed out", {
        endpoint:
          "https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials",
        kind: "request_timeout",
      }),
    );

    const response = await fetchApp(
      new Request("http://localhost/api/turn-credentials", {
        headers: {
          Cookie: await createAuthCookie({ userId: "viewer-1" }),
        },
      }),
    );

    expect(response.status).toBe(504);
    expect(await response.text()).toBe("Failed to generate TURN credentials");
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorKind: "request_timeout",
        event: "turn_credentials.generate_failed",
        level: "error",
        userId: "viewer-1",
      }),
    );
  });

  it("maps non-timeout TURN credential failures to 502", async () => {
    turnMocks.generateTurnIceServers.mockRejectedValue(
      new TurnApiError("TURN credential request failed", {
        endpoint:
          "https://rtc.live.cloudflare.com/v1/turn/keys/key/credentials",
        kind: "request_failed",
      }),
    );

    const response = await fetchApp(
      new Request("http://localhost/api/turn-credentials", {
        headers: {
          Cookie: await createAuthCookie({ userId: "viewer-1" }),
        },
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to generate TURN credentials");
  });

  it("rejects ingest when the bearer token does not match the stored hash", async () => {
    const response = await fetchApp(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer wrong-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(sfuMocks.startIngest).not.toHaveBeenCalled();
  });

  it("starts ingest after removing a stale live row", async () => {
    const staleBroadcastId = await seedLive({
      notificationMessageId: "5",
      sessionId: "stale-session",
    });
    sfuMocks.isSessionActive.mockResolvedValue(false);
    const executionContext = createExecutionContext();

    const response = await requestIngestOffer(executionContext);

    expect(response.status).toBe(201);
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ingest.request",
        level: "info",
        userId: "user-1",
      }),
    );
    expect(response.headers.get("protocol-version")).toBeNull();
    expect(response.headers.get("location")).toBe("/ingest/user-1/new-session");
    expect(response.headers.get("content-type")).toBe("application/sdp");
    expect(response.headers.get("etag")).toBe('"new-session"');
    expect(await response.text()).toBe("answer-sdp");
    expect(sfuMocks.isSessionActive).toHaveBeenCalledWith(env, "stale-session");
    expect(sfuMocks.startIngest).toHaveBeenCalledWith(
      env,
      "user-1",
      "offer-sdp",
    );
    const live = await getLive();
    expect(live).toMatchObject({
      graceExpiresAt: null,
      sessionId: "new-session",
      tracks: INGEST_SESSION.tracks,
    });
    expect(live?.broadcastId).not.toBe(staleBroadcastId);
    // 終了した配信の通知削除は LiveState が Worker に引き渡す。
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "5", userId: "user-1" },
    ]);

    await waitOnExecutionContext(executionContext);

    expect(notificationsMocks.sendLiveStartedNotification).toHaveBeenCalledWith(
      env,
      "user-1",
      "http://localhost/",
    );
    await expect(getStoredNotificationMessageId()).resolves.toBe("1");
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("resumes a broadcast in its reconnect grace period without notifying", async () => {
    const broadcastId = await seedLive({
      graceMs: 1,
      notificationMessageId: "5",
      sessionId: "previous-session",
    });
    const executionContext = createExecutionContext();

    const response = await requestIngestOffer(executionContext);

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("answer-sdp");
    expect(response.headers.get("location")).toBe("/ingest/user-1/new-session");
    // 前回セッションのトラックはその DELETE 時にすでに閉じられているため、
    // 再開前に SFU セッションの生存確認は行わない。
    expect(sfuMocks.isSessionActive).not.toHaveBeenCalled();
    await expect(getLive()).resolves.toEqual({
      broadcastId,
      graceExpiresAt: null,
      sessionId: "new-session",
      sessionSeenActiveAt: null,
      tracks: INGEST_SESSION.tracks,
      userId: "user-1",
    });
    // 再開した配信は開始通知を引き継ぎ、再接続猶予のアラームも不要になる。
    await expect(getStoredNotificationMessageId()).resolves.toBe("5");
    await expect(getLiveStateAlarm()).resolves.toBeNull();
    await waitOnExecutionContext(executionContext);
    expect(
      notificationsMocks.sendLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ingest.resumed",
        previousSessionId: "previous-session",
        reason: "reconnect_grace",
        sessionId: "new-session",
        userId: "user-1",
      }),
    );
  });

  it("starts a new broadcast when the grace period ends during negotiation", async () => {
    const previousBroadcastId = await seedLive({
      graceMs: 1,
      notificationMessageId: "5",
      sessionId: "previous-session",
    });
    sfuMocks.startIngest.mockImplementation(async () => {
      // SFUとのネゴシエーション中に猶予期間が過ぎる。
      vi.setSystemTime(NOW + 1);
      return INGEST_SESSION;
    });
    const executionContext = createExecutionContext();

    const response = await requestIngestOffer(executionContext);

    expect(response.status).toBe(201);
    const live = await getLive();
    expect(live).toMatchObject({ sessionId: "new-session" });
    expect(live?.broadcastId).not.toBe(previousBroadcastId);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "5", userId: "user-1" },
    ]);
    await waitOnExecutionContext(executionContext);
    expect(notificationsMocks.sendLiveStartedNotification).toHaveBeenCalled();
    await expect(getStoredNotificationMessageId()).resolves.toBe("1");
  });

  it("schedules the live start notification via waitUntil", async () => {
    const executionContext = createExecutionContext();

    const response = await fetchApp(
      new Request("https://wish-broad.example/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
      executionContext,
    );

    expect(response.status).toBe(201);
    // 応答は通知の送信を待たない。
    await expect(getStoredNotificationMessageId()).resolves.toBeNull();

    await waitOnExecutionContext(executionContext);

    expect(notificationsMocks.sendLiveStartedNotification).toHaveBeenCalledWith(
      env,
      "user-1",
      "https://wish-broad.example/",
    );
    await expect(getStoredNotificationMessageId()).resolves.toBe("1");
    expect(dispatch).not.toHaveBeenCalled();
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("keeps ingest successful when the live start notification fails", async () => {
    notificationsMocks.sendLiveStartedNotification.mockRejectedValue(
      new Error("webhook failed"),
    );
    const executionContext = createExecutionContext();

    const response = await requestIngestOffer(executionContext);

    expect(response.status).toBe(201);

    await waitOnExecutionContext(executionContext);

    expect(consoleWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "webhook failed",
        errorName: "Error",
        event: "live_notification.send_failed",
        level: "warn",
        sessionId: "new-session",
        userId: "user-1",
      }),
    );
    await expect(getLive()).resolves.toMatchObject({
      sessionId: "new-session",
    });
    await expect(getStoredNotificationMessageId()).resolves.toBeNull();
  });

  it("hands an orphaned start notification to the Worker when the broadcast ended before persistence", async () => {
    notificationsMocks.sendLiveStartedNotification.mockImplementation(
      async () => {
        // 通知の送信中に、SFU 上で失われたセッションとして配信が終了した。
        await getLiveState(env).endLive("user-1", "new-session");
        return { messageId: 1n };
      },
    );
    const executionContext = createExecutionContext();

    const response = await requestIngestOffer(executionContext);

    expect(response.status).toBe(201);

    await waitOnExecutionContext(executionContext);

    // 保存先の配信がないため、LiveState がメッセージの削除を Worker に引き渡した。
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "1", userId: "user-1" },
    ]);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("logs and leaves the notification when persisting its id throws", async () => {
    vi.spyOn(
      LiveState.prototype,
      "setLiveNotificationMessageId",
    ).mockRejectedValue(new Error("database unavailable"));
    const executionContext = createExecutionContext();

    const response = await requestIngestOffer(executionContext);
    expect(response.status).toBe(201);
    await waitOnExecutionContext(executionContext);

    expect(consoleWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "database unavailable",
        event: "live_notification.persist_failed",
        level: "warn",
        messageId: "1",
        sessionId: "new-session",
        userId: "user-1",
      }),
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("returns 204 for GET on the WHIP endpoint", async () => {
    const response = await fetchApp(
      new Request("http://localhost/ingest/user-1", {
        headers: {
          Authorization: "Bearer live-token",
        },
        method: "GET",
      }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("returns 204 for GET on the WHIP session resource", async () => {
    const response = await fetchApp(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: {
          Authorization: "Bearer live-token",
        },
        method: "GET",
      }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("rejects ingest when Content-Type is not application/sdp", async () => {
    const response = await fetchApp(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "text/plain",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(415);
    expect(await response.text()).toBe("Content-Type must be application/sdp");
    expect(sfuMocks.startIngest).not.toHaveBeenCalled();
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
      const response = await fetchApp(request);

      expect(response.status).toBe(status);
      expect(await response.text()).toBe(expectedBody);
      expect(sfuMocks.startIngest).not.toHaveBeenCalled();
    },
  );

  it("accepts case-insensitive SDP content types with parameters and spacing", async () => {
    const response = await fetchApp(
      new Request("http://localhost/ingest/user-1", {
        body: "offer-sdp",
        headers: {
          Authorization: "Bearer live-token",
          "Content-Type": "application/SDP ; charset=utf-8",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(201);
    expect(sfuMocks.startIngest).toHaveBeenCalledWith(
      env,
      "user-1",
      "offer-sdp",
    );
  });

  it.each(["false", "0"])(
    "honors notify=%s when starting an ingest session",
    async (notify) => {
      const executionContext = createExecutionContext();

      const response = await requestIngestOffer(
        executionContext,
        `?notify=${notify}`,
      );

      expect(response.status).toBe(201);
      await expect(getLive()).resolves.toMatchObject({
        sessionId: "new-session",
      });
      await waitOnExecutionContext(executionContext);
      expect(
        notificationsMocks.sendLiveStartedNotification,
      ).not.toHaveBeenCalled();
    },
  );

  it("rejects stale-ingest checks when the SFU cannot verify the stored session", async () => {
    await seedLive({ sessionId: "stale-session" });
    sfuMocks.isSessionActive.mockRejectedValue(
      new SfuApiError("SFU request failed", {
        endpoint: "/sessions/stale-session",
        kind: "request_failed",
      }),
    );

    const response = await requestIngestOffer();

    expect(response.status).toBe(502);
    expect(await response.text()).toBe(
      "Failed to verify ingest session status",
    );
    await expect(getLive()).resolves.toMatchObject({
      sessionId: "stale-session",
    });
    expect(sfuMocks.startIngest).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/sessions/stale-session",
        errorKind: "request_failed",
        event: "ingest.session_activity_check_failed",
        sessionId: "stale-session",
        userId: "user-1",
      }),
    );
  });

  it("returns SFU client errors for invalid ingest offers", async () => {
    sfuMocks.startIngest.mockRejectedValue(
      new SfuApiError("SFU request failed: unprocessable content", {
        endpoint: "/tracks/new",
        kind: "unprocessable_content",
        responseBody: "Malformed SDP offer",
        statusText: "Unprocessable Content",
      }),
    );
    const executionContext = createExecutionContext();

    const response = await requestIngestOffer(executionContext);

    expect(response.status).toBe(422);
    expect(await response.text()).toBe("Malformed SDP offer");
    await expect(getLive()).resolves.toBeNull();
    await waitOnExecutionContext(executionContext);
    expect(
      notificationsMocks.sendLiveStartedNotification,
    ).not.toHaveBeenCalled();
  });

  it("keeps SFU auth failures as worker errors during ingest", async () => {
    sfuMocks.startIngest.mockRejectedValue(
      new SfuApiError("SFU request failed", {
        endpoint: "/sessions/new",
        kind: "http_error",
        responseBody: "SFU auth failed",
        statusText: "Unauthorized",
      }),
    );

    const response = await requestIngestOffer();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(consoleError).toHaveBeenCalledWith(
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
    const broadcastId = await seedLive({ sessionId: "active-session" });
    const executionContext = createExecutionContext();

    const response = await requestIngestOffer(executionContext);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "A live stream is already active for this user",
    );
    expect(sfuMocks.startIngest).not.toHaveBeenCalled();
    await waitOnExecutionContext(executionContext);
    expect(
      notificationsMocks.sendLiveStartedNotification,
    ).not.toHaveBeenCalled();
    // 拒否したインジェストでもセッションの生存を記録する。
    await expect(getLive()).resolves.toMatchObject({
      broadcastId,
      sessionId: "active-session",
      sessionSeenActiveAt: NOW,
    });
  });

  it.each([
    ["skips", NOW - 9999, 0],
    ["repeats", NOW - 10_000, 1],
  ])(
    "%s the session activity record when the last one is from %i",
    async (_case, sessionSeenActiveAt, expectedCalls) => {
      await seedLive({ sessionId: "active-session", sessionSeenActiveAt });
      const markSeenActive = vi.spyOn(
        LiveState.prototype,
        "markLiveSessionSeenActive",
      );
      const executionContext = createExecutionContext();

      const response = await requestIngestOffer(executionContext);

      expect(response.status).toBe(400);
      await waitOnExecutionContext(executionContext);
      // 書き込み間隔より新しい記録であれば十分新鮮なため、LiveState を再度呼び出さない。
      expect(markSeenActive).toHaveBeenCalledTimes(expectedCalls);
      await expect(getLive()).resolves.toMatchObject({
        sessionSeenActiveAt: expectedCalls === 0 ? sessionSeenActiveAt : NOW,
      });
    },
  );

  it.each([
    ["was never seen active", undefined],
    ["was last seen active over a minute ago", NOW - 60_001],
  ])(
    "starts a new broadcast when a lost session %s",
    async (_case, sessionSeenActiveAt) => {
      const lostBroadcastId = await seedLive({
        sessionId: "lost-session",
        ...(sessionSeenActiveAt === undefined ? {} : { sessionSeenActiveAt }),
      });
      sfuMocks.isSessionActive.mockResolvedValue(false);
      const executionContext = createExecutionContext();

      const response = await requestIngestOffer(executionContext);

      expect(response.status).toBe(201);
      // 再開ではなく新しい配信として開始し、開始通知を送る。
      const live = await getLive();
      expect(live).toMatchObject({ sessionId: "new-session" });
      expect(live?.broadcastId).not.toBe(lostBroadcastId);
      await waitOnExecutionContext(executionContext);
      expect(notificationsMocks.sendLiveStartedNotification).toHaveBeenCalled();
    },
  );

  it("resumes the broadcast when OBS reconnects right after losing its session without DELETE", async () => {
    const broadcastId = await seedLive({
      sessionId: "lost-session",
      // ちょうど 1 分前までは直前（just now）とみなす。
      sessionSeenActiveAt: NOW - 60_000,
    });
    sfuMocks.isSessionActive.mockResolvedValue(false);
    const executionContext = createExecutionContext();

    const response = await requestIngestOffer(executionContext);

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/ingest/user-1/new-session");
    await expect(getLive()).resolves.toEqual({
      broadcastId,
      graceExpiresAt: null,
      sessionId: "new-session",
      sessionSeenActiveAt: null,
      tracks: INGEST_SESSION.tracks,
      userId: "user-1",
    });
    await waitOnExecutionContext(executionContext);
    expect(
      notificationsMocks.sendLiveStartedNotification,
    ).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ingest.resumed",
        previousSessionId: "lost-session",
        reason: "session_lost",
        sessionId: "new-session",
      }),
    );
  });

  it.each<[string, () => Promise<unknown>]>([
    ["no live row", async () => undefined],
    [
      "a broadcast in its grace period",
      async () => seedLive({ graceMs: 60_000, sessionId: "previous-session" }),
    ],
    [
      "a session lost just now",
      async () =>
        seedLive({ sessionId: "previous-session", sessionSeenActiveAt: NOW }),
    ],
  ])(
    "rejects an ingest that loses a race for the owner's row after reading %s",
    async (_case, seed) => {
      await seed();
      sfuMocks.isSessionActive.mockResolvedValue(false);
      // SFUとのネゴシエーション中に、競合する別のインジェストが先に行を再開または作成した。
      sfuMocks.startIngest.mockImplementation(async () => {
        const liveState = getLiveState(env);
        if (
          !(await liveState.resumeLive(
            "user-1",
            "previous-session",
            "other-session",
            createTracks("other-session"),
          ))
        ) {
          await liveState.insertLive(
            "user-1",
            "other-session",
            createTracks("other-session"),
          );
        }
        return INGEST_SESSION;
      });
      const executionContext = createExecutionContext();

      const response = await requestIngestOffer(executionContext);

      expect(response.status).toBe(400);
      expect(await response.text()).toBe(
        "A live stream is already active for this user",
      );
      await expect(getLive()).resolves.toMatchObject({
        sessionId: "other-session",
      });
      await waitOnExecutionContext(executionContext);
      expect(
        notificationsMocks.sendLiveStartedNotification,
      ).not.toHaveBeenCalled();
      expect(consoleWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "ingest.concurrent_ingest_rejected",
          sessionId: "new-session",
          userId: "user-1",
        }),
      );
    },
  );

  it("does not schedule a notification when persisting the live row fails", async () => {
    vi.spyOn(LiveState.prototype, "insertLive").mockRejectedValue(
      new Error("insert failed"),
    );
    const executionContext = createExecutionContext();

    const response = await requestIngestOffer(executionContext);

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    await waitOnExecutionContext(executionContext);
    expect(
      notificationsMocks.sendLiveStartedNotification,
    ).not.toHaveBeenCalled();
  });

  it("starts a reconnect grace period instead of ending the live on ingest delete", async () => {
    await seedLive({ notificationMessageId: "5" });
    const executionContext = createExecutionContext();

    const response = await requestIngestDelete(executionContext);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ingest.request",
        level: "info",
        sessionId: "session-1",
        userId: "user-1",
      }),
    );
    // LiveState が猶予期限と配信を終了させるアラームの両方を設定する。
    await expect(getLive()).resolves.toMatchObject({
      graceExpiresAt: NOW + 60_000,
      sessionId: "session-1",
    });
    await expect(getLiveStateAlarm()).resolves.toBe(NOW + 60_000);

    await waitOnExecutionContext(executionContext);

    expect(sfuMocks.closeTracks).toHaveBeenCalledWith(
      env,
      "session-1",
      createTracks("session-1"),
    );
    // 開始通知は猶予期間が経過して配信が終了するまで維持される。
    await expect(getStoredNotificationMessageId()).resolves.toBe("5");
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("accepts a repeated ingest delete during the grace period", async () => {
    await seedLive({ graceMs: 60_000 });
    vi.setSystemTime(NOW + 1000);
    const executionContext = createExecutionContext();

    const response = await requestIngestDelete(executionContext);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    // 重複した DELETE で猶予期限が延長されてはならない。
    await expect(getLive()).resolves.toMatchObject({
      graceExpiresAt: NOW + 60_000,
    });
    await waitOnExecutionContext(executionContext);
    expect(sfuMocks.closeTracks).not.toHaveBeenCalled();
  });

  it("rejects ingest deletion when there is no live row", async () => {
    const response = await requestIngestDelete();

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("No live stream found for this user");
    await expect(getLive()).resolves.toBeNull();
    expect(sfuMocks.closeTracks).not.toHaveBeenCalled();
  });

  it("returns success and logs when ingest close reports track errors", async () => {
    await seedLive();
    sfuMocks.closeTracks.mockResolvedValue({
      tracks: [{ mid: "0" }, { errorCode: "failed_to_close", mid: "1" }],
    });
    const executionContext = createExecutionContext();

    const response = await requestIngestDelete(executionContext);

    expect(response.status).toBe(200);
    await expect(getLive()).resolves.toMatchObject({
      graceExpiresAt: NOW + 60_000,
    });

    await waitOnExecutionContext(executionContext);

    expect(consoleWarn).toHaveBeenCalledWith(
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
  });

  it("returns success when ingest close says tracks are already gone", async () => {
    await seedLive();
    sfuMocks.closeTracks.mockRejectedValue(
      new SfuApiError("SFU request failed: session not found", {
        endpoint: "/tracks/close",
        kind: "session_not_found",
        statusText: "Not Found",
      }),
    );
    const executionContext = createExecutionContext();

    const response = await requestIngestDelete(executionContext);

    expect(response.status).toBe(200);
    await waitOnExecutionContext(executionContext);
    expect(consoleWarn).not.toHaveBeenCalled();
  });

  it("rejects ingest deletion when the session id does not match", async () => {
    await seedLive({ sessionId: "actual-session" });
    const executionContext = createExecutionContext();

    const response = await requestIngestDelete(
      executionContext,
      "other-session",
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Session ID does not match the active live stream",
    );
    await expect(getLive()).resolves.toMatchObject({ graceExpiresAt: null });
    await waitOnExecutionContext(executionContext);
    expect(sfuMocks.closeTracks).not.toHaveBeenCalled();
  });

  it.each<[string, StoredTrack[]]>([
    [
      "an empty track mid",
      [
        {
          location: "remote",
          mid: "0",
          sessionId: "session-1",
          trackName: "a",
        },
        { location: "remote", mid: "", sessionId: "session-1", trackName: "b" },
      ],
    ],
    ["no tracks", []],
  ])(
    "returns 500 when stored live track data has %s on ingest delete",
    async (_label, tracks) => {
      await seedLive({ tracks });
      const executionContext = createExecutionContext();

      const response = await requestIngestDelete(executionContext);

      expect(response.status).toBe(500);
      expect(await response.text()).toBe("Stored live track data is invalid");
      await expect(getLive()).resolves.toMatchObject({ graceExpiresAt: null });
      await waitOnExecutionContext(executionContext);
      expect(sfuMocks.closeTracks).not.toHaveBeenCalled();
    },
  );

  it("does not schedule ingest close when the grace period cannot start", async () => {
    await seedLive();
    // DELETE が行を読んだ直後に、再接続した OBS が新しいセッションで配信を再開した。
    interleaveAfterNextGetLive(async (liveState) =>
      liveState.resumeLive(
        "user-1",
        "session-1",
        "session-2",
        createTracks("session-2"),
      ),
    );
    const executionContext = createExecutionContext();

    const response = await requestIngestDelete(executionContext);

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Failed to delete the requested live stream",
    );
    await expect(getLive()).resolves.toMatchObject({
      graceExpiresAt: null,
      sessionId: "session-2",
    });
    await waitOnExecutionContext(executionContext);
    expect(sfuMocks.closeTracks).not.toHaveBeenCalled();
  });

  it("returns 404 and ends the broadcast when a stored play session is inactive", async () => {
    await seedLive({
      notificationMessageId: "5",
      sessionId: "live-session",
      userId: "streamer-1",
    });
    sfuMocks.isSessionActive.mockResolvedValue(false);
    const executionContext = createExecutionContext();

    const response = await requestPlayOffer(executionContext);

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Live stream not found: streamer-1");
    await expect(getLive("streamer-1")).resolves.toBeNull();
    // 配信を終了したことで、その開始通知の削除が Worker に引き渡された。
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "5", userId: "streamer-1" },
    ]);
    await waitOnExecutionContext(executionContext);
    expect(sfuMocks.startPlay).not.toHaveBeenCalled();
  });

  it("asks viewers to retry when an inactive play session's row changed meanwhile", async () => {
    await seedLive({ sessionId: "live-session", userId: "streamer-1" });
    sfuMocks.isSessionActive.mockImplementation(async () => {
      // SFUへの確認中に OBS が新しいセッションで配信を再開した。
      await getLiveState(env).resumeLive(
        "streamer-1",
        "live-session",
        "resumed-session",
        createTracks("resumed-session"),
      );
      return false;
    });

    const response = await requestPlayOffer();

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("2");
    await expect(getLive("streamer-1")).resolves.toMatchObject({
      sessionId: "resumed-session",
    });
    expect(sfuMocks.startPlay).not.toHaveBeenCalled();
  });

  it.each([
    ["is still ahead", undefined],
    // LiveState は応答前に期限切れの配信を終了させるため、返された期限時刻は
    // Worker の時計上で過ぎていても LiveState の時計上ではまだ過ぎていない。
    ["looks passed on the Worker's clock", NOW + 1],
  ])(
    "asks viewers to retry while the stored grace deadline %s",
    async (_case, workerNow) => {
      await seedLive({
        graceMs: 1,
        sessionId: "live-session",
        userId: "streamer-1",
      });
      if (workerNow !== undefined) {
        interleaveAfterNextGetLive(() => {
          vi.setSystemTime(workerNow);
          return undefined;
        });
      }

      const response = await requestPlayOffer();

      expect(response.status).toBe(409);
      expect(response.headers.get("retry-after")).toBe("2");
      expect(await response.text()).toBe(
        "Live stream is waiting for the publisher to reconnect",
      );
      expect(sfuMocks.isSessionActive).not.toHaveBeenCalled();
      expect(sfuMocks.startPlay).not.toHaveBeenCalled();
    },
  );

  it("returns a logged 502 when the SFU cannot verify a play session", async () => {
    await seedLive({ sessionId: "live-session", userId: "streamer-1" });
    sfuMocks.isSessionActive.mockRejectedValue(
      new SfuApiError("SFU request failed", {
        endpoint: "/sessions/live-session",
        kind: "request_failed",
      }),
    );

    const response = await requestPlayOffer();

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to verify live stream status");
    expect(sfuMocks.startPlay).not.toHaveBeenCalled();
    await expect(getLive("streamer-1")).resolves.not.toBeNull();
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "/sessions/live-session",
        errorKind: "request_failed",
        errorMessage: "SFU request failed",
        event: "play.session_activity_check_failed",
        level: "error",
        sessionId: "live-session",
        userId: "streamer-1",
      }),
    );
  });

  it("maps a missing live from the playback negotiator to 404", async () => {
    sfuMocks.startPlay.mockRejectedValue(new LiveNotFoundError("streamer-1"));

    const response = await requestPlayOffer();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Live stream not found: streamer-1");
  });

  it("leaves non-SFU playback errors to the unhandled error handler", async () => {
    sfuMocks.startPlay.mockRejectedValue(
      new TypeError("unexpected playback error"),
    );

    const response = await requestPlayOffer();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "unexpected playback error",
        event: "worker.unhandled_error",
        level: "error",
      }),
    );
  });

  it("logs SFU playback negotiation errors and returns 502", async () => {
    sfuMocks.startPlay.mockRejectedValue(
      new SfuApiError("SFU request failed", {
        endpoint: "/tracks/new",
        kind: "http_error",
        statusText: "Internal Server Error",
      }),
    );

    const response = await requestPlayOffer();

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to negotiate playback session");
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "SFU request failed",
        event: "play.negotiation_failed",
        level: "error",
        viewerUserId: "viewer-1",
      }),
    );
  });

  it("waits for OBS when the SFU loses the session between its check and play start", async () => {
    await seedLive({ sessionId: "live-session", userId: "streamer-1" });
    sfuMocks.startPlay.mockRejectedValue(
      new SfuApiError("SFU request failed: session not found", {
        endpoint: "/tracks/new",
        kind: "session_not_found",
        statusText: "Not Found",
      }),
    );

    const response = await requestPlayOffer();

    // セッションが直前まで生存していたため、OBS はたった今失われたと判定される。
    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("2");
    await expect(getLive("streamer-1")).resolves.toMatchObject({
      graceExpiresAt: NOW + 30_000,
      sessionId: "live-session",
    });
    await expect(getLiveStateAlarm()).resolves.toBe(NOW + 30_000);
  });

  it("starts a short grace period when a play request finds a session lost just now", async () => {
    await seedLive({
      sessionId: "live-session",
      sessionSeenActiveAt: NOW - 5000,
      userId: "streamer-1",
    });
    sfuMocks.isSessionActive.mockResolvedValue(false);

    const response = await requestPlayOffer();

    expect(response.status).toBe(409);
    expect(response.headers.get("retry-after")).toBe("2");
    // LiveState が猶予期限と配信を終了させるアラームの両方を設定する。
    await expect(getLive("streamer-1")).resolves.toMatchObject({
      graceExpiresAt: NOW + 30_000,
    });
    await expect(getLiveStateAlarm()).resolves.toBe(NOW + 30_000);
    expect(sfuMocks.startPlay).not.toHaveBeenCalled();
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "live.session_lost",
        graceExpiresAt: NOW + 30_000,
        sessionId: "live-session",
        userId: "streamer-1",
      }),
    );
  });

  it("asks viewers to retry if a lost session's row changed before its grace period started", async () => {
    await seedLive({
      sessionId: "live-session",
      sessionSeenActiveAt: NOW,
      userId: "streamer-1",
    });
    sfuMocks.isSessionActive.mockImplementation(async () => {
      // SFUへの確認中に OBS が DELETE を送信した。
      await getLiveState(env).startLiveReconnectGrace(
        "streamer-1",
        "live-session",
        60_000,
      );
      return false;
    });

    const response = await requestPlayOffer();

    expect(response.status).toBe(409);
    await expect(getLive("streamer-1")).resolves.toMatchObject({
      graceExpiresAt: NOW + 60_000,
    });
    expect(consoleInfo).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "live.session_lost" }),
    );
  });

  it("records that a play request found the session active", async () => {
    await seedLive({ sessionId: "live-session", userId: "streamer-1" });
    const executionContext = createExecutionContext();

    const response = await requestPlayOffer(executionContext);

    expect(response.status).toBe(201);
    await waitOnExecutionContext(executionContext);
    await expect(getLive("streamer-1")).resolves.toMatchObject({
      sessionSeenActiveAt: NOW,
    });
  });

  it("keeps playback successful and logs when the activity record fails", async () => {
    await seedLive({ sessionId: "live-session", userId: "streamer-1" });
    vi.spyOn(
      LiveState.prototype,
      "markLiveSessionSeenActive",
    ).mockRejectedValue(new Error("live state unavailable"));
    const executionContext = createExecutionContext();

    const response = await requestPlayOffer(executionContext);

    expect(response.status).toBe(201);
    await waitOnExecutionContext(executionContext);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "live state unavailable",
        event: "live.session_activity_record_failed",
        sessionId: "live-session",
        userId: "streamer-1",
      }),
    );
  });

  it("returns 404 when the SFU loses playback for an owner with no stored row", async () => {
    sfuMocks.startPlay.mockRejectedValue(
      new SfuApiError("Session not found", {
        endpoint: "/tracks/new",
        kind: "session_not_found",
      }),
    );

    const response = await requestPlayOffer();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Live stream not found: streamer-1");
    expect(sfuMocks.startPlay).toHaveBeenCalledWith(
      env,
      "streamer-1",
      [],
      "viewer-offer",
    );
    await expect(getLive("streamer-1")).resolves.toBeNull();
  });

  it("returns 400 for an empty WHEP offer", async () => {
    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1", {
        body: "",
        headers: {
          Cookie: await createAuthCookie(),
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("SDP offer is required");
    expect(sfuMocks.startPlay).not.toHaveBeenCalled();
  });

  it("rejects whitespace WHEP offers and offers with no Content-Type", async () => {
    const cookie = await createAuthCookie();
    const whitespace = await fetchApp(
      new Request("http://localhost/play/streamer-1", {
        body: "   ",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/sdp",
        },
        method: "POST",
      }),
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
    const missingType = await fetchApp(noContentTypeRequest);
    expect(missingType.status).toBe(415);
    expect(await missingType.text()).toBe(
      "Content-Type must be application/sdp",
    );
    expect(sfuMocks.startPlay).not.toHaveBeenCalled();
  });

  it("returns 204 for GET on the WHEP endpoint", async () => {
    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1", {
        headers: {
          Cookie: await createAuthCookie(),
        },
        method: "GET",
      }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("returns 204 for GET on the WHEP session resource", async () => {
    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        headers: {
          Cookie: await createAuthCookie(),
        },
        method: "GET",
      }),
    );

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("rejects WHEP offers when Content-Type is not application/sdp", async () => {
    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1", {
        body: "viewer-offer",
        headers: {
          Cookie: await createAuthCookie(),
          "Content-Type": "text/plain",
          Origin: "http://localhost",
        },
        method: "POST",
      }),
    );

    expect(response.status).toBe(415);
    expect(await response.text()).toBe("Content-Type must be application/sdp");
    expect(sfuMocks.startPlay).not.toHaveBeenCalled();
  });

  it("returns SFU client errors for invalid WHEP offers", async () => {
    await seedLive({ sessionId: "live-session", userId: "streamer-1" });
    sfuMocks.startPlay.mockRejectedValue(
      new SfuApiError("SFU request failed: unprocessable content", {
        endpoint: "/tracks/new",
        kind: "unprocessable_content",
        responseBody: "Malformed SDP offer",
        statusText: "Unprocessable Content",
      }),
    );

    const response = await requestPlayOffer();

    expect(response.status).toBe(422);
    expect(await response.text()).toBe("Malformed SDP offer");
  });

  it("checks the live session before starting play", async () => {
    const liveTracks = createTracks("live-session");
    await seedLive({
      sessionId: "live-session",
      tracks: liveTracks,
      userId: "streamer-1",
    });

    const response = await requestPlayOffer();

    expect(response.status).toBe(201);
    expect(await response.text()).toBe("viewer-answer-sdp");
    expect(response.headers.get("content-type")).toBe("application/sdp");
    expect(response.headers.get("etag")).toBe('"viewer-session"');
    expect(consoleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "play.request",
        level: "info",
        userId: "viewer-1",
      }),
    );
    expect(sfuMocks.isSessionActive).toHaveBeenCalledWith(env, "live-session");
    expect(sfuMocks.startPlay).toHaveBeenCalledWith(
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
    await seedLive({ sessionId: "live-session", userId: "streamer-1" });
    sfuMocks.startPlay.mockResolvedValue({
      sdpAnswer: "viewer-counter-offer-sdp",
      sessionId: "viewer-session",
      sdpType: "offer",
      tracks: createTracks("viewer-session"),
    });

    const response = await requestPlayOffer();

    expect(response.status).toBe(406);
    expect(await response.text()).toBe("viewer-counter-offer-sdp");
    expect(response.headers.get("Wish-Live-Track-Count")).toBe("1");
    expect(response.headers.get("location")).toBe(
      "http://localhost/play/streamer-1/viewer-session?mid=0",
    );
    expect(response.headers.get("x-session-description-type")).toBeNull();
  });

  it("closes WHEP playback tracks on DELETE", async () => {
    const executionContext = createExecutionContext();

    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1/viewer-session?mid=0", {
        headers: {
          Cookie: await createAuthCookie(),
          Origin: "http://localhost",
        },
        method: "DELETE",
      }),
      executionContext,
    );

    expect(response.status).toBe(200);

    await waitOnExecutionContext(executionContext);

    expect(sfuMocks.closeTracks).toHaveBeenCalledWith(env, "viewer-session", [
      {
        location: "remote",
        mid: "0",
        sessionId: "viewer-session",
        trackName: "0",
      },
    ]);
  });

  it("rejects WHEP playback DELETE without track mids", async () => {
    const executionContext = createExecutionContext();

    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        headers: {
          Cookie: await createAuthCookie(),
          Origin: "http://localhost",
        },
        method: "DELETE",
      }),
      executionContext,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("WHEP session track mids are required");
    await waitOnExecutionContext(executionContext);
    expect(sfuMocks.closeTracks).not.toHaveBeenCalled();
  });

  it("rejects WHEP session requests whose session id is not URL-safe", async () => {
    const executionContext = createExecutionContext();
    // Hono はパラメーター内の %2F や %3F をデコードするため、検証がないと
    // SFUAPI の URL が別のパスへ書き換えられてしまう。
    const sessionUrl = "http://localhost/play/streamer-1/..%2F..%2Fother%3F";

    const deleteResponse = await fetchApp(
      new Request(`${sessionUrl}?mid=0`, {
        headers: {
          Cookie: await createAuthCookie(),
          Origin: "http://localhost",
        },
        method: "DELETE",
      }),
      executionContext,
    );
    const patchResponse = await fetchApp(
      new Request(sessionUrl, {
        body: "viewer-answer",
        headers: {
          Cookie: await createAuthCookie(),
          "Content-Type": "application/sdp",
        },
        method: "PATCH",
      }),
      executionContext,
    );

    expect(deleteResponse.status).toBe(400);
    expect(await deleteResponse.text()).toBe("Invalid WHEP session ID");
    expect(patchResponse.status).toBe(400);
    expect(await patchResponse.text()).toBe("Invalid WHEP session ID");
    await waitOnExecutionContext(executionContext);
    expect(sfuMocks.closeTracks).not.toHaveBeenCalled();
    expect(sfuMocks.renegotiateSession).not.toHaveBeenCalled();
  });

  it("trims and deduplicates requested WHEP track mids", async () => {
    const executionContext = createExecutionContext();

    const response = await fetchApp(
      new Request(
        "http://localhost/play/streamer-1/viewer-session?mid=%20&mid=0&mid=0&mid=1%20",
        {
          headers: {
            Cookie: await createAuthCookie(),
            Origin: "http://localhost",
          },
          method: "DELETE",
        },
      ),
      executionContext,
    );

    expect(response.status).toBe(200);
    await waitOnExecutionContext(executionContext);
    expect(sfuMocks.closeTracks).toHaveBeenCalledWith(env, "viewer-session", [
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
    sfuMocks.closeTracks.mockResolvedValue({
      tracks: [{ errorCode: "failed_to_close", mid: "0" }],
    });
    const executionContext = createExecutionContext();

    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1/viewer-session?mid=0", {
        headers: {
          Cookie: await createAuthCookie(),
          Origin: "http://localhost",
        },
        method: "DELETE",
      }),
      executionContext,
    );

    expect(response.status).toBe(200);

    await waitOnExecutionContext(executionContext);

    expect(consoleWarn).toHaveBeenCalledWith(
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
    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        body: "",
        headers: {
          Cookie: await createAuthCookie(),
          "Content-Type": "application/sdp",
        },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("SDP answer is required");
    expect(sfuMocks.renegotiateSession).not.toHaveBeenCalled();
  });

  it("rejects WHEP answers when Content-Type is not application/sdp", async () => {
    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        body: "viewer-answer",
        headers: {
          Cookie: await createAuthCookie(),
          "Content-Type": "text/plain",
          Origin: "http://localhost",
        },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(415);
    expect(await response.text()).toBe("Content-Type must be application/sdp");
    expect(sfuMocks.renegotiateSession).not.toHaveBeenCalled();
  });

  it("returns SFU client errors for invalid WHEP answers", async () => {
    sfuMocks.renegotiateSession.mockRejectedValue(
      new SfuApiError("SFU request failed: unprocessable content", {
        endpoint: "/renegotiate",
        kind: "unprocessable_content",
        responseBody: "Malformed SDP answer",
        statusText: "Unprocessable Content",
      }),
    );

    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        body: "viewer-answer",
        headers: {
          Cookie: await createAuthCookie(),
          "Content-Type": "application/sdp",
        },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(422);
    expect(await response.text()).toBe("Malformed SDP answer");
  });

  it("returns 204 after successful WHEP renegotiation", async () => {
    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        body: "viewer-answer",
        headers: {
          Cookie: await createAuthCookie(),
          "Content-Type": "application/sdp",
        },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(204);
    expect(sfuMocks.renegotiateSession).toHaveBeenCalledWith(
      env,
      "viewer-session",
      "viewer-answer",
    );
  });

  it("logs non-SFU WHEP answer errors and returns 502", async () => {
    sfuMocks.renegotiateSession.mockRejectedValue(
      new SfuApiError("unexpected renegotiation error", {
        endpoint: "/renegotiate",
        kind: "request_failed",
      }),
    );

    const response = await fetchApp(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        body: "viewer-answer",
        headers: {
          Cookie: await createAuthCookie(),
          "Content-Type": "application/sdp",
        },
        method: "PATCH",
      }),
    );

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to submit WHEP answer");
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "unexpected renegotiation error",
        event: "play.answer_submission_failed",
        level: "error",
        sessionId: "viewer-session",
      }),
    );
  });
});
