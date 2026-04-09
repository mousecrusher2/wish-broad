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

  return {
    CallsApiError: MockCallsApiError,
    LiveNotFoundError: MockLiveNotFoundError,
    closeTracks: vi.fn<() => Promise<unknown>>(),
    isSessionActive: vi.fn<() => Promise<boolean>>(),
    renegotiateSession: vi.fn<() => Promise<Response>>(),
    startIngest: vi.fn<() => Promise<unknown>>(),
    startPlay: vi.fn<() => Promise<unknown>>(),
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
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

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

    callsMocks.closeTracks.mockResolvedValue({});
    callsMocks.isSessionActive.mockResolvedValue(true);
    callsMocks.renegotiateSession.mockResolvedValue(new Response(null));
    callsMocks.startIngest.mockReset();
    callsMocks.startIngest.mockResolvedValue({
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
    });
    callsMocks.startPlay.mockReset();
    callsMocks.startPlay.mockResolvedValue({
      sdpAnswer: "viewer-answer-sdp",
      sessionId: "viewer-session",
    });
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
    callsMocks.isSessionActive.mockResolvedValue(false);

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
    callsMocks.isSessionActive.mockResolvedValue(true);

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
    callsMocks.closeTracks.mockResolvedValue({
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
    callsMocks.closeTracks.mockRejectedValue(
      new callsMocks.CallsApiError(404, "Not Found", "/tracks/close"),
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
    dbMocks.shouldCheckSession.mockResolvedValue(true);
    callsMocks.isSessionActive.mockResolvedValue(false);

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
    callsMocks.startPlay.mockRejectedValue(
      new callsMocks.CallsApiError(404, "Not Found", "/tracks/new"),
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

  it("updates the session check time before starting play", async () => {
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
    dbMocks.shouldCheckSession.mockResolvedValue(true);
    callsMocks.isSessionActive.mockResolvedValue(true);

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
    expect(dbMocks.updateSessionCheckTime).toHaveBeenCalledWith(
      env.LIVE_DB,
      "streamer-1",
    );
    expect(callsMocks.startPlay).toHaveBeenCalledWith(
      env,
      "streamer-1",
      liveTracks,
      "viewer-offer",
    );
    expect(response.headers.get("location")).toBe(
      "/play/streamer-1/viewer-session",
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

  it("forwards the renegotiation status code from Calls", async () => {
    const env = createBindings();

    callsMocks.renegotiateSession.mockResolvedValue(
      new Response(null, { status: 204 }),
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
