import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SfuApiError } from "../clients/sfu";
import { getLiveState, LiveState } from "../state/live-state";
import {
  createAuthCookie,
  createTracks,
  fetchApp,
  getLive,
  getLiveStateAlarm,
  interleaveAfterNextGetLive,
  NOW,
  seedLive,
  setUpWorkerTest,
} from "../testing/app";

// SFU のクライアントは ../clients/sfu.test.ts で HTTP レベルまで検証しているため、ここでは
// クライアントとの境界で差し替える。
const sfuMocks = vi.hoisted(() => ({
  closeTracks: vi.fn<() => Promise<unknown>>(),
  createPlaybackSession: vi.fn<() => Promise<unknown>>(),
  isSessionActive: vi.fn<() => Promise<boolean>>(),
  renegotiateSession: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../clients/sfu", async () => ({
  ...(await vi.importActual<typeof import("../clients/sfu")>("../clients/sfu")),
  ...sfuMocks,
}));

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

describe("play routes", () => {
  const spies = setUpWorkerTest();

  beforeEach(() => {
    for (const mock of Object.values(sfuMocks)) {
      mock.mockReset();
    }
    sfuMocks.closeTracks.mockResolvedValue({});
    sfuMocks.createPlaybackSession.mockResolvedValue({
      sdpAnswer: "viewer-answer-sdp",
      sessionId: "viewer-session",
      sdpType: "answer",
      tracks: createTracks("viewer-session"),
    });
    sfuMocks.isSessionActive.mockResolvedValue(true);
    sfuMocks.renegotiateSession.mockResolvedValue(undefined);
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
    expect(spies.dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "5", userId: "streamer-1" },
    ]);
    await waitOnExecutionContext(executionContext);
    expect(sfuMocks.createPlaybackSession).not.toHaveBeenCalled();
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
    expect(sfuMocks.createPlaybackSession).not.toHaveBeenCalled();
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
      expect(sfuMocks.createPlaybackSession).not.toHaveBeenCalled();
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
    expect(sfuMocks.createPlaybackSession).not.toHaveBeenCalled();
    await expect(getLive("streamer-1")).resolves.not.toBeNull();
    expect(spies.consoleError).toHaveBeenCalledWith(
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

  it("returns 404 without asking the SFU when no live is stored", async () => {
    const response = await requestPlayOffer();

    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Live stream not found: streamer-1");
    expect(sfuMocks.isSessionActive).not.toHaveBeenCalled();
    expect(sfuMocks.createPlaybackSession).not.toHaveBeenCalled();
  });

  it("leaves non-SFU playback errors to the unhandled error handler", async () => {
    await seedLive({ sessionId: "live-session", userId: "streamer-1" });
    sfuMocks.createPlaybackSession.mockRejectedValue(
      new TypeError("unexpected playback error"),
    );

    const response = await requestPlayOffer();

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Internal Server Error");
    expect(spies.consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "unexpected playback error",
        event: "worker.unhandled_error",
        level: "error",
      }),
    );
  });

  it("logs SFU playback negotiation errors and returns 502", async () => {
    await seedLive({ sessionId: "live-session", userId: "streamer-1" });
    sfuMocks.createPlaybackSession.mockRejectedValue(
      new SfuApiError("SFU request failed", {
        endpoint: "/tracks/new",
        kind: "http_error",
        statusText: "Internal Server Error",
      }),
    );

    const response = await requestPlayOffer();

    expect(response.status).toBe(502);
    expect(await response.text()).toBe("Failed to negotiate playback session");
    expect(spies.consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "SFU request failed",
        event: "play.negotiation_failed",
        level: "error",
        viewerUserId: "viewer-1",
      }),
    );
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
    expect(sfuMocks.createPlaybackSession).not.toHaveBeenCalled();
    expect(spies.consoleInfo).toHaveBeenCalledWith(
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
    expect(spies.consoleInfo).not.toHaveBeenCalledWith(
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
    expect(spies.consoleWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "live state unavailable",
        event: "live.session_activity_record_failed",
        sessionId: "live-session",
        userId: "streamer-1",
      }),
    );
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
    expect(sfuMocks.createPlaybackSession).not.toHaveBeenCalled();
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
    expect(sfuMocks.createPlaybackSession).not.toHaveBeenCalled();
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
    expect(sfuMocks.createPlaybackSession).not.toHaveBeenCalled();
  });

  it("returns SFU client errors for invalid WHEP offers", async () => {
    await seedLive({ sessionId: "live-session", userId: "streamer-1" });
    sfuMocks.createPlaybackSession.mockRejectedValue(
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
    expect(spies.consoleInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "play.request",
        level: "info",
        userId: "viewer-1",
      }),
    );
    expect(sfuMocks.isSessionActive).toHaveBeenCalledWith(env, "live-session");
    expect(sfuMocks.createPlaybackSession).toHaveBeenCalledWith(
      env,
      liveTracks,
      "viewer-offer",
    );
    expect(response.headers.get("Wish-Live-Track-Count")).toBe("1");
    expect(response.headers.get("access-control-expose-headers")).toBeNull();
    expect(response.headers.get("accept-patch")).toBeNull();
    expect(response.headers.get("location")).toBe(
      "http://localhost/play/streamer-1/viewer-session",
    );
  });

  it("returns a WHEP counter-offer with 406", async () => {
    await seedLive({ sessionId: "live-session", userId: "streamer-1" });
    sfuMocks.createPlaybackSession.mockResolvedValue({
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
      "http://localhost/play/streamer-1/viewer-session",
    );
    expect(response.headers.get("x-session-description-type")).toBeNull();
  });

  it.each(["", "?mid=0"])(
    "accepts a WHEP playback DELETE%s without touching the SFU",
    async (query) => {
      const executionContext = createExecutionContext();

      const response = await fetchApp(
        new Request(`http://localhost/play/streamer-1/viewer-session${query}`, {
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
      expect(sfuMocks.closeTracks).not.toHaveBeenCalled();
    },
  );

  it("rejects WHEP answers whose session id is not URL-safe", async () => {
    const executionContext = createExecutionContext();
    // Hono はパラメーター内の %2F や %3F をデコードするため、検証がないと
    // SFUAPI の URL が別のパスへ書き換えられてしまう。
    const sessionUrl = "http://localhost/play/streamer-1/..%2F..%2Fother%3F";

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

    expect(patchResponse.status).toBe(400);
    expect(await patchResponse.text()).toBe("Invalid WHEP session ID");
    await waitOnExecutionContext(executionContext);
    expect(sfuMocks.renegotiateSession).not.toHaveBeenCalled();
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
    expect(spies.consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "unexpected renegotiation error",
        event: "play.answer_submission_failed",
        level: "error",
        sessionId: "viewer-session",
      }),
    );
  });
});
