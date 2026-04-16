import { sign } from "hono/jwt";
import { err, ok } from "neverthrow";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "./types";
import type { DiscordGuildMember, DiscordOAuthToken } from "./discord";
import type { StoredTrack } from "./calls";
import { hashTokenWithPepper } from "./token-hash";

const dbMocks = vi.hoisted(() => ({
  deleteTracksForSession: vi.fn<() => Promise<boolean>>(),
  getAllLives: vi.fn<() => Promise<unknown[]>>(),
  getLiveTokenHash: vi.fn<() => Promise<string | null>>(),
  getLiveTrackRecord: vi.fn<
    () => Promise<{
      userId: string;
      sessionId: string;
      tracks: StoredTrack[];
    } | null>
  >(),
  getTracks: vi.fn<() => Promise<unknown[]>>(),
  getUser:
    vi.fn<() => Promise<{ displayName: string; userId: string } | null>>(),
  hasLiveToken: vi.fn<() => Promise<boolean>>(),
  setLiveToken: vi.fn<() => Promise<void>>(),
  setTracks: vi.fn<() => Promise<void>>(),
  setUser: vi.fn<() => Promise<void>>(),
}));

const callsMocks = vi.hoisted(() => {
  class MockCallsApiError extends Error {
    constructor(
      public readonly statusCode: number,
      public readonly statusText: string,
      public readonly endpoint: string,
      public readonly responseBody?: unknown,
    ) {
      super(
        `Calls API Error: ${String(statusCode)} ${statusText} at ${endpoint}`,
      );
      this.name = "CallsApiError";
    }

    toNegotiationClientError(
      fallbackText: string,
    ): { status: 400 | 415 | 422; text: string } | null {
      if (
        this.statusCode !== 400 &&
        this.statusCode !== 415 &&
        this.statusCode !== 422
      ) {
        return null;
      }

      const text =
        typeof this.responseBody === "string" && this.responseBody.length > 0
          ? this.responseBody
          : fallbackText;

      return {
        status: this.statusCode,
        text,
      };
    }
  }

  class MockLiveNotFoundError extends Error {
    constructor(liveId: string) {
      super(`Live stream not found: ${liveId}`);
      this.name = "LiveNotFoundError";
    }
  }

  return {
    CallsApiError: MockCallsApiError,
    LiveNotFoundError: MockLiveNotFoundError,
    closeTracks: vi.fn<() => Promise<unknown>>(),
    isSessionActive: vi.fn<() => Promise<unknown>>(),
    renegotiateSession: vi.fn<() => Promise<unknown>>(),
    startIngest: vi.fn<() => Promise<unknown>>(),
    startPlay: vi.fn<() => Promise<unknown>>(),
  };
});

const discordMocks = vi.hoisted(() => {
  class MockDiscordApiError extends Error {
    constructor(
      public readonly endpoint: string,
      public readonly statusCode?: number,
      public readonly statusText?: string,
      public readonly responseBodyText?: string,
      public readonly responseBodyJson?: unknown,
    ) {
      super("Discord API Error");
      this.name = "DiscordApiError";
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
      vi.fn<
        (accessToken: string, guildId: string) => Promise<unknown>
      >(),
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
vi.mock("./calls", () => ({
  CallsApiError: callsMocks.CallsApiError,
  LiveNotFoundError: callsMocks.LiveNotFoundError,
  closeTracks: callsMocks.closeTracks,
  isSessionActive: callsMocks.isSessionActive,
  renegotiateSession: callsMocks.renegotiateSession,
  startIngest: callsMocks.startIngest,
  startPlay: callsMocks.startPlay,
}));
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
    dump() {
      throw new Error("Unexpected D1 access in tests");
    },
  };
}

function createExecutionContext(): ExecutionContext {
  return {
    passThroughOnException() {},
    waitUntil(promise: Promise<unknown>) {
      void promise;
    },
    props: undefined,
  };
}

function createBindings(): Bindings {
  return {
    AUTHORIZED_GUILD_ID: "guild-1",
    CALLS_APP_ID: "calls-app-id",
    CALLS_APP_SECRET: "calls-app-secret",
    DISCORD_CLIENT_ID: "discord-client-id",
    DISCORD_CLIENT_SECRET: "discord-client-secret",
    ENVIRONMENT: "test",
    JWT_SECRET: "test-jwt-secret",
    LIVE_DB: createUnusedD1Database(),
    LIVE_TOKEN_PEPPER: "test-live-token-pepper",
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

describe("worker app", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    dbMocks.deleteTracksForSession.mockResolvedValue(true);
    dbMocks.getAllLives.mockResolvedValue([]);
    dbMocks.getLiveTokenHash.mockResolvedValue(
      await hashTokenWithPepper("test-live-token-pepper", "live-token"),
    );
    dbMocks.getLiveTrackRecord.mockResolvedValue(null);
    dbMocks.getTracks.mockResolvedValue([]);
    dbMocks.getUser.mockResolvedValue(null);
    dbMocks.hasLiveToken.mockResolvedValue(false);
    dbMocks.setLiveToken.mockResolvedValue();
    dbMocks.setTracks.mockResolvedValue();
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

  it("rejects Discord login when the user is not in the authorized guild", async () => {
    const env = createBindings();

    discordMocks.getGuildMember.mockResolvedValue(
      err(
        new discordMocks.DiscordApiError(
          `https://discord.com/api/v10/users/@me/guilds/${env.AUTHORIZED_GUILD_ID}/member`,
          404,
          "Not Found",
        ),
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

  it("issues a live token for an authenticated user", async () => {
    const env = createBindings();
    const request = new Request("http://localhost/api/me/livetoken", {
      headers: {
        Cookie: await createAuthCookie(env, { userId: "user-1" }),
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
    const staleTracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "stale-session",
        trackName: "video",
      },
    ];

    dbMocks.getLiveTrackRecord.mockResolvedValue({
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
      createExecutionContext(),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("protocol-version")).toBeNull();
    expect(dbMocks.deleteTracksForSession).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      "stale-session",
    );
    expect(callsMocks.startIngest).toHaveBeenCalledWith(
      env,
      "user-1",
      "offer-sdp",
    );
    expect(dbMocks.setTracks).toHaveBeenCalledWith(
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
    expect(response.headers.get("location")).toBe("/ingest/user-1/new-session");
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

  it("returns Calls client errors for invalid ingest offers", async () => {
    const env = createBindings();

    callsMocks.startIngest.mockResolvedValue(
      err(
        new callsMocks.CallsApiError(
          422,
          "Unprocessable Content",
          "/tracks/new",
          "Malformed SDP offer",
        ),
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

    expect(response.status).toBe(422);
    expect(await response.text()).toBe("Malformed SDP offer");
  });

  it("keeps Calls auth failures as worker errors during ingest", async () => {
    const env = createBindings();

    callsMocks.startIngest.mockResolvedValue(
      err(
        new callsMocks.CallsApiError(
          401,
          "Unauthorized",
          "/sessions/new",
          "Calls auth failed",
        ),
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

    dbMocks.getLiveTrackRecord.mockResolvedValue({
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
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "A live stream is already active for this user",
    );
    expect(dbMocks.deleteTracksForSession).not.toHaveBeenCalled();
    expect(callsMocks.startIngest).not.toHaveBeenCalled();
    expect(dbMocks.setTracks).not.toHaveBeenCalled();
  });

  it("closes publisher tracks before deleting an ingest session", async () => {
    const env = createBindings();
    const tracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "session-1",
        trackName: "video",
      },
    ];

    dbMocks.getLiveTrackRecord.mockResolvedValue({
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

    const response = await app.fetch(request, env, createExecutionContext());

    expect(response.status).toBe(200);
    expect(callsMocks.closeTracks).toHaveBeenCalledWith(
      env,
      "session-1",
      tracks,
    );
    expect(dbMocks.deleteTracksForSession).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      "session-1",
    );
  });

  it("keeps the live row when Calls reports track close errors", async () => {
    const env = createBindings();

    dbMocks.getLiveTrackRecord.mockResolvedValue({
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
        tracks: [{ errorCode: "failed_to_close", mid: "0" }],
      }),
    );

    const request = new Request("http://localhost/ingest/user-1/session-1", {
      headers: {
        Authorization: "Bearer live-token",
      },
      method: "DELETE",
    });

    const response = await app.fetch(request, env, createExecutionContext());

    expect(response.status).toBe(502);
    expect(dbMocks.deleteTracksForSession).not.toHaveBeenCalled();
  });

  it("deletes the live row when Calls says tracks are already gone", async () => {
    const env = createBindings();

    dbMocks.getLiveTrackRecord.mockResolvedValue({
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
      err(new callsMocks.CallsApiError(404, "Not Found", "/tracks/close")),
    );

    const response = await app.fetch(
      new Request("http://localhost/ingest/user-1/session-1", {
        headers: {
          Authorization: "Bearer live-token",
        },
        method: "DELETE",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
    expect(dbMocks.deleteTracksForSession).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      "session-1",
    );
  });

  it("rejects ingest deletion when the session id does not match", async () => {
    const env = createBindings();

    dbMocks.getLiveTrackRecord.mockResolvedValue({
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
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Session ID does not match the active live stream",
    );
    expect(callsMocks.closeTracks).not.toHaveBeenCalled();
    expect(dbMocks.deleteTracksForSession).not.toHaveBeenCalled();
  });

  it("returns 500 when stored live track data is invalid on ingest delete", async () => {
    const env = createBindings();

    dbMocks.getLiveTrackRecord.mockResolvedValue({
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
      createExecutionContext(),
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Stored live track data is invalid");
    expect(callsMocks.closeTracks).not.toHaveBeenCalled();
    expect(dbMocks.deleteTracksForSession).not.toHaveBeenCalled();
  });

  it("returns 404 and cleans up when a stored play session is inactive", async () => {
    const env = createBindings();
    const liveTracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "live-session",
        trackName: "video",
      },
    ];

    dbMocks.getLiveTrackRecord.mockResolvedValue({
      sessionId: "live-session",
      tracks: liveTracks,
      userId: "streamer-1",
    });
    callsMocks.isSessionActive.mockResolvedValue(ok(false));

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

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Live stream not found: streamer-1");
    expect(dbMocks.deleteTracksForSession).toHaveBeenCalledWith(
      env.LIVE_DB,
      "streamer-1",
      "live-session",
    );
    expect(callsMocks.startPlay).not.toHaveBeenCalled();
  });

  it("returns 404 and cleans up when Calls loses the live during play start", async () => {
    const env = createBindings();
    const liveTracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "live-session",
        trackName: "video",
      },
    ];

    dbMocks.getLiveTrackRecord.mockResolvedValue({
      sessionId: "live-session",
      tracks: liveTracks,
      userId: "streamer-1",
    });
    callsMocks.startPlay.mockResolvedValue(
      err(new callsMocks.CallsApiError(404, "Not Found", "/tracks/new")),
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

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Live stream not found: streamer-1");
    expect(dbMocks.deleteTracksForSession).toHaveBeenCalledWith(
      env.LIVE_DB,
      "streamer-1",
      "live-session",
    );
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

  it("returns Calls client errors for invalid WHEP offers", async () => {
    const env = createBindings();
    const liveTracks: StoredTrack[] = [
      {
        location: "remote",
        mid: "0",
        sessionId: "live-session",
        trackName: "video",
      },
    ];

    dbMocks.getLiveTrackRecord.mockResolvedValue({
      sessionId: "live-session",
      tracks: liveTracks,
      userId: "streamer-1",
    });
    callsMocks.startPlay.mockResolvedValue(
      err(
        new callsMocks.CallsApiError(
          422,
          "Unprocessable Content",
          "/tracks/new",
          "Malformed SDP offer",
        ),
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

    dbMocks.getLiveTrackRecord.mockResolvedValue({
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

    dbMocks.getLiveTrackRecord.mockResolvedValue({
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
    expect(response.headers.get("location")).toBe(
      "http://localhost/play/streamer-1/viewer-session?mid=0",
    );
    expect(response.headers.get("x-session-description-type")).toBeNull();
  });

  it("closes WHEP playback tracks on DELETE", async () => {
    const env = createBindings();

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session?mid=0", {
        headers: {
          Cookie: await createAuthCookie(env),
        },
        method: "DELETE",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(200);
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

    const response = await app.fetch(
      new Request("http://localhost/play/streamer-1/viewer-session", {
        headers: {
          Cookie: await createAuthCookie(env),
        },
        method: "DELETE",
      }),
      env,
      createExecutionContext(),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("WHEP session track mids are required");
    expect(callsMocks.closeTracks).not.toHaveBeenCalled();
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

  it("returns Calls client errors for invalid WHEP answers", async () => {
    const env = createBindings();

    callsMocks.renegotiateSession.mockResolvedValue(
      err(
        new callsMocks.CallsApiError(
          422,
          "Unprocessable Content",
          "/renegotiate",
          "Malformed SDP answer",
        ),
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
});
