import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LIVE_RECONNECT_GRACE_MS } from "../../shared/protocol";
import { SfuApiError } from "../clients/sfu";
import { hashTokenWithPepper } from "../lib/token-hash";
import type { StoredTrack } from "../live/types";
import { getLiveState, LiveState } from "../state/live-state";
import {
  createTracks,
  fetchApp,
  getLive,
  getLiveStateAlarm,
  getStoredNotificationMessageId,
  interleaveAfterNextGetLive,
  NOW,
  seedLive,
  setUpWorkerTest,
} from "../testing/app";

// SFU と Discord Webhook のクライアントは各モジュールのテストで HTTP レベルまで検証して
// いるため、ここではクライアントとの境界で差し替える。
const sfuMocks = vi.hoisted(() => ({
  closeTracks: vi.fn<() => Promise<unknown>>(),
  createIngestSession:
    vi.fn<typeof import("../clients/sfu").createIngestSession>(),
  isSessionActive: vi.fn<typeof import("../clients/sfu").isSessionActive>(),
}));

const notificationsMocks = vi.hoisted(() => ({
  sendLiveStartedNotification: vi.fn<() => Promise<unknown>>(),
}));

vi.mock("../clients/sfu", async () => ({
  ...(await vi.importActual<typeof import("../clients/sfu")>("../clients/sfu")),
  ...sfuMocks,
}));
vi.mock("../clients/discord-webhook", async () => ({
  ...(await vi.importActual<typeof import("../clients/discord-webhook")>(
    "../clients/discord-webhook",
  )),
  ...notificationsMocks,
}));

const INGEST_SESSION = {
  sdpAnswer: "answer-sdp",
  sessionId: "new-session",
  tracks: createTracks("new-session"),
};

/** SFU とのネゴシエーションの間に、偽の時計を `elapsedMs` ミリ秒進める。 */
function finishNegotiationAfter(elapsedMs: number): void {
  sfuMocks.createIngestSession.mockImplementation(async () => {
    vi.advanceTimersByTime(elapsedMs);
    return INGEST_SESSION;
  });
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

describe("ingest routes", () => {
  const spies = setUpWorkerTest();

  beforeEach(async () => {
    for (const mock of [
      ...Object.values(sfuMocks),
      ...Object.values(notificationsMocks),
    ]) {
      mock.mockReset();
    }
    sfuMocks.closeTracks.mockResolvedValue({});
    sfuMocks.createIngestSession.mockResolvedValue(INGEST_SESSION);
    sfuMocks.isSessionActive.mockResolvedValue(true);
    notificationsMocks.sendLiveStartedNotification.mockResolvedValue({
      messageId: 1n,
    });

    // user-1 は配信トークン "live-token" を発行済み。
    await getLiveState(env).setLiveToken(
      "user-1",
      await hashTokenWithPepper(env.LIVE_TOKEN_PEPPER, "live-token"),
    );
  });

  it("uses a one minute reconnect grace period", () => {
    expect(LIVE_RECONNECT_GRACE_MS).toBe(60_000);
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
    expect(sfuMocks.createIngestSession).not.toHaveBeenCalled();
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
    expect(spies.consoleInfo).toHaveBeenCalledWith(
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
    // 生存確認とネゴシエーションは同じ締め切りに従う。
    const deadline = sfuMocks.isSessionActive.mock.calls[0]?.[2];
    expect(deadline).toBeInstanceOf(AbortSignal);
    expect(sfuMocks.isSessionActive).toHaveBeenCalledWith(
      env,
      "stale-session",
      deadline,
    );
    expect(sfuMocks.createIngestSession).toHaveBeenCalledWith(
      env,
      "offer-sdp",
      deadline,
    );
    const live = await getLive();
    expect(live).toMatchObject({
      graceExpiresAt: null,
      sessionId: "new-session",
      tracks: INGEST_SESSION.tracks,
    });
    expect(live?.broadcastId).not.toBe(staleBroadcastId);
    // 終了した配信の通知削除は LiveState が Worker に引き渡す。
    expect(spies.dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "5", userId: "user-1" },
    ]);

    await waitOnExecutionContext(executionContext);

    expect(notificationsMocks.sendLiveStartedNotification).toHaveBeenCalledWith(
      env,
      "user-1",
      "http://localhost/",
    );
    await expect(getStoredNotificationMessageId()).resolves.toBe("1");
    expect(spies.consoleWarn).not.toHaveBeenCalled();
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
    expect(spies.consoleInfo).toHaveBeenCalledWith(
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
    sfuMocks.createIngestSession.mockImplementation(async () => {
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
    expect(spies.dispatch).toHaveBeenCalledExactlyOnceWith([
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
    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(spies.consoleWarn).not.toHaveBeenCalled();
  });

  it("keeps ingest successful when the live start notification fails", async () => {
    notificationsMocks.sendLiveStartedNotification.mockRejectedValue(
      new Error("webhook failed"),
    );
    const executionContext = createExecutionContext();

    const response = await requestIngestOffer(executionContext);

    expect(response.status).toBe(201);

    await waitOnExecutionContext(executionContext);

    expect(spies.consoleWarn).toHaveBeenCalledWith(
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
    expect(spies.dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "1", userId: "user-1" },
    ]);
    expect(spies.consoleWarn).not.toHaveBeenCalled();
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

    expect(spies.consoleWarn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "database unavailable",
        event: "live_notification.persist_failed",
        level: "warn",
        messageId: "1",
        sessionId: "new-session",
        userId: "user-1",
      }),
    );
    expect(spies.dispatch).not.toHaveBeenCalled();
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
    expect(sfuMocks.createIngestSession).not.toHaveBeenCalled();
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
      expect(sfuMocks.createIngestSession).not.toHaveBeenCalled();
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
    expect(sfuMocks.createIngestSession).toHaveBeenCalledWith(
      env,
      "offer-sdp",
      expect.any(AbortSignal),
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
    expect(sfuMocks.createIngestSession).not.toHaveBeenCalled();
    expect(spies.consoleError).toHaveBeenCalledWith(
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
    sfuMocks.createIngestSession.mockRejectedValue(
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
    sfuMocks.createIngestSession.mockRejectedValue(
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
    expect(spies.consoleError).toHaveBeenCalledWith(
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
    expect(sfuMocks.createIngestSession).not.toHaveBeenCalled();
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
    expect(spies.dispatch).not.toHaveBeenCalled();
    expect(spies.consoleInfo).toHaveBeenCalledWith(
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
      sfuMocks.createIngestSession.mockImplementation(async () => {
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
      expect(spies.consoleWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "ingest.concurrent_ingest_rejected",
          sessionId: "new-session",
          userId: "user-1",
        }),
      );
    },
  );

  describe("with the six-second ingest deadline", () => {
    beforeEach(() => {
      // setSystemTime で固定した時計を、締め切りのタイマーと一緒に進む偽の時計に置き換える。
      vi.useRealTimers();
      vi.useFakeTimers({
        now: NOW,
        toFake: ["Date", "setTimeout", "clearTimeout"],
      });
    });

    it("starts a broadcast whose negotiation finishes just before the deadline", async () => {
      finishNegotiationAfter(5_999);
      const executionContext = createExecutionContext();

      const response = await requestIngestOffer(executionContext);

      expect(response.status).toBe(201);
      await expect(getLive()).resolves.toMatchObject({
        sessionId: "new-session",
      });
      // 応答した後に締め切りのタイマーを残さない。
      expect(vi.getTimerCount()).toBe(0);
      await waitOnExecutionContext(executionContext);
    });

    it("does not start a broadcast when the negotiation finishes at the deadline", async () => {
      finishNegotiationAfter(6_000);
      const executionContext = createExecutionContext();

      const response = await requestIngestOffer(executionContext);

      expect(response.status).toBe(504);
      expect(await response.text()).toBe(
        "Timed out while starting the ingest session",
      );
      // SFU に渡した締め切りも中断されている。
      expect(sfuMocks.createIngestSession.mock.calls[0]?.[2]?.aborted).toBe(
        true,
      );
      await expect(getLive()).resolves.toBeNull();
      await waitOnExecutionContext(executionContext);
      expect(
        notificationsMocks.sendLiveStartedNotification,
      ).not.toHaveBeenCalled();
      expect(spies.consoleWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "ingest.deadline_exceeded",
          sessionId: "new-session",
          userId: "user-1",
        }),
      );
    });

    it("does not resume a broadcast in its grace period after the deadline", async () => {
      const broadcastId = await seedLive({
        graceMs: 60_000,
        notificationMessageId: "5",
        sessionId: "previous-session",
      });
      finishNegotiationAfter(6_000);

      const response = await requestIngestOffer();

      expect(response.status).toBe(504);
      // 配信は猶予期間のまま残り、次の再接続を待つ。
      await expect(getLive()).resolves.toMatchObject({
        broadcastId,
        graceExpiresAt: NOW + 60_000,
        sessionId: "previous-session",
      });
      await expect(getStoredNotificationMessageId()).resolves.toBe("5");
      await expect(getLiveStateAlarm()).resolves.toBe(NOW + 60_000);
    });
  });

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
    expect(spies.consoleInfo).toHaveBeenCalledWith(
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

    expect(sfuMocks.closeTracks).toHaveBeenCalledWith(env, "session-1", ["0"]);
    // 開始通知は猶予期間が経過して配信が終了するまで維持される。
    await expect(getStoredNotificationMessageId()).resolves.toBe("5");
    expect(spies.dispatch).not.toHaveBeenCalled();
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

    expect(spies.consoleWarn).toHaveBeenCalledWith(
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
    expect(spies.consoleWarn).not.toHaveBeenCalled();
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
});
