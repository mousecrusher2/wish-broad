import { env } from "cloudflare:workers";
import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { deleteStartNotifications } from "./notifications";

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

describe("start notification deletes", () => {
  let fetchSpy: MockInstance<typeof fetch>;
  // テストランナーの console はアクセスのたびに別の関数を返すため、スパイは戻り値で参照する。
  let warn: MockInstance<Console["warn"]>;

  beforeEach(() => {
    // Discord Webhook の DELETE に成功を返す。
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("deletes each notification", async () => {
    // 実際の Discord snowflake と同様、Number.MAX_SAFE_INTEGER より大きい値。
    await deleteStartNotifications(env, [
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

      await deleteStartNotifications(env, [JOB]);

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

    await deleteStartNotifications(env, [JOB]);

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

    await deleteStartNotifications(env, [JOB]);

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
});
