import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
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
import { getDueNotificationDeletes } from "./database";
import { LIVE_RECONNECT_GRACE_MS, runNotificationDeletes } from "./live-end";
import { getLiveState, LiveState } from "./live-state";

/** 実際のアラームが自動発火しないよう、テストの時計は遠い未来に置く。 */
const NOW = Date.UTC(2100, 0, 1);

const WEBHOOK_URL = env.NOTIFICATIONS_DISCORD_WEBHOOK_URL;

/** 終了済みの配信に対する開始通知を報告し、LiveState の削除キューへ追加させる。 */
async function queueNotificationDelete(
  messageId: string,
  userId: string,
): Promise<void> {
  await getLiveState(env).setLiveNotificationMessageId(
    userId,
    "ended-broadcast",
    messageId,
  );
}

/** リース中のものも含め、LiveState がまだ Discord から削除済みと把握していない通知。 */
async function getQueuedMessageIds(): Promise<string[]> {
  return runInDurableObject(getLiveState(env), (_instance, state) =>
    getDueNotificationDeletes(state.storage.sql, Number.MAX_SAFE_INTEGER).map(
      (entry) => entry.messageId,
    ),
  );
}

function getRequestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : input.toString();
}

function getDeletedMessageUrls(fetchSpy: MockInstance<typeof fetch>): string[] {
  return fetchSpy.mock.calls.map(([input, init]) => {
    expect(init?.method).toBe("DELETE");
    return getRequestUrl(input);
  });
}

describe("live end", () => {
  let fetchSpy: MockInstance<typeof fetch>;
  // テストランナーの console はアクセスのたびに別の関数を返すため、スパイは戻り値で参照する。
  let warn: MockInstance<Console["warn"]>;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    // Discord Webhook の DELETE に成功を返す。
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await reset();
  });

  it("uses a one minute grace period", () => {
    expect(LIVE_RECONNECT_GRACE_MS).toBe(60_000);
  });

  it("deletes each notification and reports them as finished", async () => {
    // 実際の Discord snowflake と同様、Number.MAX_SAFE_INTEGER より大きい値。
    await queueNotificationDelete("1300000000000000123", "user-1");
    await queueNotificationDelete("9", "user-2");

    await runNotificationDeletes(env, [
      { messageId: "1300000000000000123", userId: "user-1" },
      { messageId: "9", userId: "user-2" },
    ]);

    expect(getDeletedMessageUrls(fetchSpy)).toEqual([
      `${WEBHOOK_URL}/messages/1300000000000000123`,
      `${WEBHOOK_URL}/messages/9`,
    ]);
    await expect(getQueuedMessageIds()).resolves.toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])(
    "leaves a delete that failed with %i for a later attempt",
    async (status) => {
      await queueNotificationDelete("9", "user-1");
      fetchSpy.mockImplementation(async () => new Response(null, { status }));

      await runNotificationDeletes(env, [{ messageId: "9", userId: "user-1" }]);

      await expect(getQueuedMessageIds()).resolves.toEqual(["9"]);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          errorKind: "http_error",
          event: "live_notification.delete_failed",
          messageId: "9",
          userId: "user-1",
          willRetry: true,
        }),
      );
    },
  );

  it("leaves a delete that timed out for a later attempt", async () => {
    await queueNotificationDelete("9", "user-1");
    fetchSpy.mockRejectedValue(new DOMException("aborted", "AbortError"));

    await runNotificationDeletes(env, [{ messageId: "9", userId: "user-1" }]);

    await expect(getQueuedMessageIds()).resolves.toEqual(["9"]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        errorKind: "request_timeout",
        event: "live_notification.delete_failed",
        willRetry: true,
      }),
    );
  });

  it("finishes a delete that Discord rejects, without another attempt", async () => {
    await queueNotificationDelete("9", "user-1");
    fetchSpy.mockImplementation(
      async () => new Response("Unknown Message", { status: 404 }),
    );

    await runNotificationDeletes(env, [{ messageId: "9", userId: "user-1" }]);

    await expect(getQueuedMessageIds()).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        endpoint: "https://discord.com/api/webhooks/123/[redacted]/messages/9",
        event: "live_notification.delete_failed",
        messageId: "9",
        willRetry: false,
      }),
    );
  });

  it("reports only the deletes that finished", async () => {
    await queueNotificationDelete("8", "user-1");
    await queueNotificationDelete("9", "user-2");
    fetchSpy.mockImplementation(async (input) =>
      getRequestUrl(input).endsWith("/messages/8")
        ? new Response(null, { status: 503 })
        : new Response(null, { status: 204 }),
    );

    await runNotificationDeletes(env, [
      { messageId: "8", userId: "user-1" },
      { messageId: "9", userId: "user-2" },
    ]);

    await expect(getQueuedMessageIds()).resolves.toEqual(["8"]);
  });

  it("logs instead of throwing when the result cannot be reported", async () => {
    vi.spyOn(
      LiveState.prototype,
      "settleNotificationDeletes",
    ).mockRejectedValue(new Error("live state unavailable"));

    await expect(
      runNotificationDeletes(env, [{ messageId: "9", userId: "user-1" }]),
    ).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        errorMessage: "live state unavailable",
        event: "live_notification.settle_failed",
        messageIds: ["9"],
      }),
    );
  });

  it("returns to the live state before Discord answers", async () => {
    await queueNotificationDelete("9", "user-1");
    let respond!: (response: Response) => void;
    fetchSpy.mockReturnValue(
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
    );

    await exports.LiveEffects.deleteStartNotifications([
      { messageId: "9", userId: "user-1" },
    ]);

    // オブジェクトは Discord の応答を待たずに次の処理へ進める。
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
    await expect(getQueuedMessageIds()).resolves.toEqual(["9"]);

    respond(new Response(null, { status: 204 }));
    await vi.waitFor(async () => {
      await expect(getQueuedMessageIds()).resolves.toEqual([]);
    });
  });

  it("deletes an ended broadcast's notification once the alarm hands it to the Worker", async () => {
    const liveState = getLiveState(env);
    const broadcastId = await liveState.insertLive("user-1", "session-1", []);
    assert.isNotNull(broadcastId, "Expected a new broadcast");
    await liveState.setLiveNotificationMessageId("user-1", broadcastId, "9");
    await liveState.startLiveReconnectGrace(
      "user-1",
      "session-1",
      LIVE_RECONNECT_GRACE_MS,
    );

    vi.setSystemTime(NOW + LIVE_RECONNECT_GRACE_MS);
    await expect(runDurableObjectAlarm(liveState)).resolves.toBe(true);

    await vi.waitFor(async () => {
      await expect(getQueuedMessageIds()).resolves.toEqual([]);
    });
    expect(getDeletedMessageUrls(fetchSpy)).toEqual([
      `${WEBHOOK_URL}/messages/9`,
    ]);
    await expect(liveState.getLive("user-1")).resolves.toBeNull();
    await expect(
      runInDurableObject(liveState, async (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).resolves.toBeNull();
  });
});
