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
import { LIVE_RECONNECT_GRACE_MS, runNotificationDeletes } from "./live-end";
import { getLiveState } from "./live-state";

/** 実際のアラームが自動発火しないよう、テストの時計は遠い未来に置く。 */
const NOW = Date.UTC(2100, 0, 1);

const WEBHOOK_URL = env.NOTIFICATIONS_DISCORD_WEBHOOK_URL;

const JOB = { messageId: "9", userId: "user-1" };

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

  it("deletes each notification", async () => {
    // 実際の Discord snowflake と同様、Number.MAX_SAFE_INTEGER より大きい値。
    await runNotificationDeletes(env, [
      { messageId: "1300000000000000123", userId: "user-1" },
      { messageId: "9", userId: "user-2" },
    ]);

    expect(getDeletedMessageUrls(fetchSpy)).toEqual([
      `${WEBHOOK_URL}/messages/1300000000000000123`,
      `${WEBHOOK_URL}/messages/9`,
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])(
    "retries a delete that failed with %i once",
    async (status) => {
      fetchSpy.mockImplementationOnce(
        async () => new Response(null, { status }),
      );

      await runNotificationDeletes(env, [JOB]);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
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

  it("gives up when the retry also times out", async () => {
    fetchSpy.mockRejectedValue(new DOMException("aborted", "AbortError"));

    await runNotificationDeletes(env, [JOB]);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        errorKind: "request_timeout",
        event: "live_notification.delete_failed",
        willRetry: true,
      }),
    );
    expect(warn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        errorKind: "request_timeout",
        event: "live_notification.delete_failed",
        willRetry: false,
      }),
    );
  });

  it("does not retry a delete that Discord rejects", async () => {
    fetchSpy.mockImplementation(
      async () => new Response("Unknown Message", { status: 404 }),
    );

    await runNotificationDeletes(env, [JOB]);

    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        endpoint: "https://discord.com/api/webhooks/123/[redacted]/messages/9",
        event: "live_notification.delete_failed",
        messageId: "9",
        willRetry: false,
      }),
    );
  });

  it("returns to the live state before Discord answers", async () => {
    let respond!: (response: Response) => void;
    fetchSpy.mockReturnValue(
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
    );

    await exports.LiveEffects.deleteStartNotifications([JOB]);

    // オブジェクトは Discord の応答を待たずに次の処理へ進める。
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
    respond(new Response(null, { status: 204 }));
  });

  it("deletes an ended broadcast's notification once the alarm ends it", async () => {
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

    await vi.waitFor(() => {
      expect(getDeletedMessageUrls(fetchSpy)).toEqual([
        `${WEBHOOK_URL}/messages/9`,
      ]);
    });
    await expect(liveState.getLive("user-1")).resolves.toBeNull();
    await expect(
      runInDurableObject(liveState, async (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).resolves.toBeNull();
  });
});
