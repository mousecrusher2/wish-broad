import { sign } from "hono/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bindings, StoredTrack } from "./types";

const dbMocks = vi.hoisted(() => ({
  deleteTracksForSession: vi.fn<() => Promise<boolean>>(),
  getAllLives: vi.fn<() => Promise<unknown[]>>(),
  getLiveToken: vi.fn<() => Promise<string | null>>(),
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
  shouldCheckSession: vi.fn<() => Promise<boolean>>(),
  updateSessionCheckTime: vi.fn<() => Promise<void>>(),
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
  }

  class MockLiveNotFoundError extends Error {
    constructor(liveId: string) {
      super(`Live stream not found: ${liveId}`);
      this.name = "LiveNotFoundError";
    }
  }

  const client = {
    closeTracks: vi.fn<() => Promise<unknown>>(),
    createIngestTracks: vi.fn<() => Promise<unknown>>(),
    createSession: vi.fn<() => Promise<unknown>>(),
    isSessionActive: vi.fn<() => Promise<boolean>>(),
    renegotiateSession: vi.fn<() => Promise<Response>>(),
  };

  class MockCallsClient {
    closeTracks = client.closeTracks;
    createIngestTracks = client.createIngestTracks;
    createSession = client.createSession;
    isSessionActive = client.isSessionActive;
    renegotiateSession = client.renegotiateSession;
  }

  return {
    CallsApiError: MockCallsApiError,
    CallsClient: MockCallsClient,
    LiveNotFoundError: MockLiveNotFoundError,
    client,
    startIngest: vi.fn<() => Promise<unknown>>(),
    startPlay: vi.fn<() => Promise<unknown>>(),
  };
});

vi.mock("./database", () => dbMocks);
vi.mock("./calls", () => ({
  CallsApiError: callsMocks.CallsApiError,
  CallsClient: callsMocks.CallsClient,
  LiveNotFoundError: callsMocks.LiveNotFoundError,
  startIngest: callsMocks.startIngest,
  startPlay: callsMocks.startPlay,
}));

import app from "./index";

function createExecutionContext(): ExecutionContext {
  return {
    passThroughOnException() {},
    waitUntil() {},
  } as ExecutionContext;
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
    LIVE_DB: {} as D1Database,
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
  beforeEach(() => {
    vi.clearAllMocks();

    dbMocks.deleteTracksForSession.mockResolvedValue(true);
    dbMocks.getAllLives.mockResolvedValue([]);
    dbMocks.getLiveToken.mockResolvedValue("live-token");
    dbMocks.getLiveTrackRecord.mockResolvedValue(null);
    dbMocks.getTracks.mockResolvedValue([]);
    dbMocks.getUser.mockResolvedValue(null);
    dbMocks.hasLiveToken.mockResolvedValue(false);
    dbMocks.setLiveToken.mockResolvedValue();
    dbMocks.setTracks.mockResolvedValue();
    dbMocks.setUser.mockResolvedValue();
    dbMocks.shouldCheckSession.mockResolvedValue(false);
    dbMocks.updateSessionCheckTime.mockResolvedValue();

    callsMocks.client.closeTracks.mockResolvedValue({});
    callsMocks.client.createIngestTracks.mockResolvedValue({});
    callsMocks.client.createSession.mockResolvedValue({});
    callsMocks.client.isSessionActive.mockResolvedValue(true);
    callsMocks.client.renegotiateSession.mockResolvedValue(new Response(null));
    callsMocks.startIngest.mockReset();
    callsMocks.startPlay.mockReset();
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

    const body = (await response.json()) as {
      success: boolean;
      token: string;
    };

    expect(body.success).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(dbMocks.setLiveToken).toHaveBeenCalledWith(
      env.LIVE_DB,
      "user-1",
      body.token,
    );
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
    expect(callsMocks.client.closeTracks).toHaveBeenCalledWith(
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
    callsMocks.client.closeTracks.mockResolvedValue({
      tracks: [{ errorCode: "failed_to_close", mid: "0" }],
    });

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
});
