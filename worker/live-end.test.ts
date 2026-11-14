import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordWebhookError } from "./notifications";
import { createUnusedLiveStateNamespace } from "./test-doubles";

const mocks = vi.hoisted(() => ({
  deleteLiveStartedNotification: vi.fn<() => Promise<unknown>>(),
  settleNotificationDeletes: vi.fn<(messageIds: string[]) => Promise<void>>(),
}));

vi.mock("./live-state", () => ({
  getLiveState: () => ({
    settleNotificationDeletes: mocks.settleNotificationDeletes,
  }),
}));
vi.mock("./notifications", async () => ({
  ...(await vi.importActual<typeof import("./notifications")>(
    "./notifications",
  )),
  deleteLiveStartedNotification: mocks.deleteLiveStartedNotification,
}));

import { LIVE_RECONNECT_GRACE_MS, runNotificationDeletes } from "./live-end";

function createEnv() {
  return {
    ENVIRONMENT: "production",
    LIVE_STATE: createUnusedLiveStateNamespace(),
    LOG_LEVEL: "info",
    NOTIFICATIONS_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/t",
  };
}

function discordError(status: number): DiscordWebhookError {
  return new DiscordWebhookError("Discord webhook request failed", {
    endpoint: "https://discord.com/api/webhooks/1/t/messages/9",
    kind: "http_error",
    status,
  });
}

describe("live end", () => {
  beforeEach(() => {
    mocks.deleteLiveStartedNotification.mockReset();
    mocks.deleteLiveStartedNotification.mockResolvedValue(undefined);
    mocks.settleNotificationDeletes.mockReset();
    mocks.settleNotificationDeletes.mockResolvedValue();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("uses a one minute grace period", () => {
    expect(LIVE_RECONNECT_GRACE_MS).toBe(60_000);
  });

  it("deletes each notification and reports them as finished", async () => {
    const env = createEnv();

    await runNotificationDeletes(env, [
      // Larger than Number.MAX_SAFE_INTEGER, like real Discord snowflakes.
      { messageId: "1300000000000000123", userId: "user-1" },
      { messageId: "9", userId: "user-2" },
    ]);

    expect(mocks.deleteLiveStartedNotification).toHaveBeenCalledWith(
      env,
      1_300_000_000_000_000_123n,
    );
    expect(mocks.deleteLiveStartedNotification).toHaveBeenCalledWith(env, 9n);
    expect(mocks.settleNotificationDeletes).toHaveBeenCalledExactlyOnceWith([
      "1300000000000000123",
      "9",
    ]);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])(
    "leaves a delete that failed with %i for a later attempt",
    async (status) => {
      mocks.deleteLiveStartedNotification.mockRejectedValue(
        discordError(status),
      );

      await runNotificationDeletes(createEnv(), [
        { messageId: "9", userId: "user-1" },
      ]);

      expect(mocks.settleNotificationDeletes).not.toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          event: "live_notification.delete_failed",
          messageId: "9",
          userId: "user-1",
          willRetry: true,
        }),
      );
    },
  );

  it("leaves a delete that timed out for a later attempt", async () => {
    mocks.deleteLiveStartedNotification.mockRejectedValue(
      new DiscordWebhookError("Discord webhook request timed out", {
        endpoint: "https://discord.com/api/webhooks/1/t/messages/9",
        kind: "request_timeout",
      }),
    );

    await runNotificationDeletes(createEnv(), [
      { messageId: "9", userId: "user-1" },
    ]);

    expect(mocks.settleNotificationDeletes).not.toHaveBeenCalled();
  });

  it("finishes a delete that Discord rejects, without another attempt", async () => {
    mocks.deleteLiveStartedNotification.mockRejectedValue(discordError(404));

    await runNotificationDeletes(createEnv(), [
      { messageId: "9", userId: "user-1" },
    ]);

    expect(mocks.settleNotificationDeletes).toHaveBeenCalledExactlyOnceWith([
      "9",
    ]);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        endpoint: "https://discord.com/api/webhooks/1/[redacted]/messages/9",
        event: "live_notification.delete_failed",
        messageId: "9",
        willRetry: false,
      }),
    );
  });

  it("reports only the deletes that finished", async () => {
    mocks.deleteLiveStartedNotification
      .mockRejectedValueOnce(discordError(503))
      .mockResolvedValueOnce(undefined);

    await runNotificationDeletes(createEnv(), [
      { messageId: "8", userId: "user-1" },
      { messageId: "9", userId: "user-2" },
    ]);

    expect(mocks.settleNotificationDeletes).toHaveBeenCalledExactlyOnceWith([
      "9",
    ]);
  });

  it("logs instead of throwing when the result cannot be reported", async () => {
    mocks.settleNotificationDeletes.mockRejectedValue(
      new Error("live state unavailable"),
    );

    await expect(
      runNotificationDeletes(createEnv(), [
        { messageId: "9", userId: "user-1" },
      ]),
    ).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        errorMessage: "live state unavailable",
        event: "live_notification.settle_failed",
        messageIds: ["9"],
      }),
    );
  });
});
