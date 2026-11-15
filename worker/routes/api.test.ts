import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TurnApiError } from "../clients/turn";
import { hashTokenWithPepper } from "../lib/token-hash";
import { getLiveState, LiveState } from "../state/live-state";
import {
  createAuthCookie,
  fetchApp,
  seedLive,
  setUpWorkerTest,
} from "../testing/app";

// TURN のクライアントは ../clients/turn.test.ts で HTTP レベルまで検証しているため、
// ここではルートとの境界で差し替える。
const turnMocks = vi.hoisted(() => ({
  generateTurnIceServers: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../clients/turn", async () => ({
  ...(await vi.importActual<typeof import("../clients/turn")>(
    "../clients/turn",
  )),
  ...turnMocks,
}));

async function requestLiveTokenStatus(userId: string): Promise<Response> {
  return fetchApp(
    new Request("http://localhost/api/me/livetoken", {
      headers: { Cookie: await createAuthCookie({ userId }) },
    }),
  );
}

describe("api routes", () => {
  const spies = setUpWorkerTest();

  beforeEach(async () => {
    turnMocks.generateTurnIceServers.mockReset();
    turnMocks.generateTurnIceServers.mockResolvedValue([
      {
        urls: ["stun:stun.cloudflare.com:3478"],
      },
    ]);

    // user-1 は配信トークン "live-token" を発行済み。
    await getLiveState(env).setLiveToken(
      "user-1",
      await hashTokenWithPepper(env.LIVE_TOKEN_PEPPER, "live-token"),
    );
  });

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
    expect(spies.consoleError).toHaveBeenCalledWith(
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
    expect(spies.consoleError).toHaveBeenCalledWith(
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
    expect(spies.consoleError).toHaveBeenCalledWith(
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
    expect(spies.consoleInfo).toHaveBeenCalledWith(
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
    expect(spies.consoleError).toHaveBeenCalledWith(
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
});
