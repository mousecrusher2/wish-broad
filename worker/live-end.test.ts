import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordWebhookError } from "./notifications";

const mocks = vi.hoisted(() => ({
  deleteLiveStartedNotification: vi.fn<() => Promise<unknown>>(),
  endLive:
    vi.fn<() => Promise<{ notificationMessageId: bigint | null } | null>>(),
}));

vi.mock("./database", () => ({ endLive: mocks.endLive }));
vi.mock("./notifications", async () => ({
  ...(await vi.importActual<typeof import("./notifications")>(
    "./notifications",
  )),
  deleteLiveStartedNotification: mocks.deleteLiveStartedNotification,
}));

import {
  LIVE_RECONNECT_GRACE_MS,
  type LiveEndParams,
  runLiveEnd,
  scheduleLiveEnd,
} from "./live-end";

const params = {
  graceExpiresAt: 1_700_000_060_000,
  sessionId: "session-1",
  userId: "user-1",
};

function failUnexpectedAccess(): never {
  throw new Error("Unexpected access in tests");
}

function createEnv() {
  return {
    // endLive is mocked, so the database itself is never touched.
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- An opaque handle passed through to the mocked endLive.
    LIVE_DB: {} as D1Database,
    LOG_LEVEL: "info",
    NOTIFICATIONS_DISCORD_WEBHOOK_URL: "https://discord.com/api/webhooks/1/t",
  };
}

function createWorkflowInstance(): WorkflowInstance {
  return {
    delete: failUnexpectedAccess,
    id: "instance-1",
    pause: failUnexpectedAccess,
    restart: failUnexpectedAccess,
    resume: failUnexpectedAccess,
    sendEvent: failUnexpectedAccess,
    status: failUnexpectedAccess,
    subscribe: failUnexpectedAccess,
    terminate: failUnexpectedAccess,
  };
}

// Mirrors Workflows: each step runs its callback once and records the result,
// and a throwing callback rejects the step after its retries are exhausted.
function createStep() {
  const calls: string[] = [];
  const step = {
    async do<T extends string | null>(
      name: string,
      callback: () => Promise<T>,
    ): Promise<T> {
      calls.push(`do:${name}`);
      return callback();
    },
    async sleepUntil(name: string, timestamp: number): Promise<void> {
      calls.push(`sleepUntil:${name}:${String(timestamp)}`);
    },
  };
  return { calls, step };
}

function discordError(status: number): DiscordWebhookError {
  return new DiscordWebhookError("Discord webhook request failed", {
    endpoint: "https://discord.com/api/webhooks/1/t/messages/9",
    kind: "http_error",
    status,
  });
}

describe("live end workflow", () => {
  beforeEach(() => {
    mocks.endLive.mockReset();
    mocks.deleteLiveStartedNotification.mockReset();
    mocks.deleteLiveStartedNotification.mockResolvedValue(undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  it("uses a one minute grace period", () => {
    expect(LIVE_RECONNECT_GRACE_MS).toBe(60_000);
  });

  it("schedules one Workflow instance with the grace parameters", async () => {
    const create =
      vi.fn<
        (
          options?: WorkflowInstanceCreateOptions<LiveEndParams>,
        ) => Promise<WorkflowInstance>
      >();
    create.mockResolvedValue(createWorkflowInstance());

    await scheduleLiveEnd(
      {
        LIVE_END_WORKFLOW: {
          create,
          createBatch: failUnexpectedAccess,
          deleteBatch: failUnexpectedAccess,
          get: failUnexpectedAccess,
        },
      },
      params,
    );

    expect(create).toHaveBeenCalledExactlyOnceWith({ params });
  });

  it("ends the live after the grace deadline and deletes its notification", async () => {
    const env = createEnv();
    const { calls, step } = createStep();
    mocks.endLive.mockResolvedValue({
      notificationMessageId: 1_300_000_000_000_000_123n,
    });

    await runLiveEnd(env, params, step);

    expect(calls).toEqual([
      "sleepUntil:wait for the publisher to reconnect:1700000060000",
      "do:end the live",
      "do:delete the start notification",
    ]);
    expect(mocks.endLive).toHaveBeenCalledWith(env.LIVE_DB, params);
    expect(mocks.deleteLiveStartedNotification).toHaveBeenCalledWith(
      env,
      1_300_000_000_000_000_123n,
    );
    expect(console.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "live.ended",
        reason: "reconnect_grace_expired",
        sessionId: "session-1",
        userId: "user-1",
      }),
    );
  });

  it("does nothing more when the publisher resumed the broadcast", async () => {
    const { calls, step } = createStep();
    mocks.endLive.mockResolvedValue(null);

    await runLiveEnd(createEnv(), params, step);

    expect(calls).toEqual([
      "sleepUntil:wait for the publisher to reconnect:1700000060000",
      "do:end the live",
    ]);
    expect(mocks.deleteLiveStartedNotification).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
  });

  it("skips notification cleanup when the broadcast never stored one", async () => {
    const { calls, step } = createStep();
    mocks.endLive.mockResolvedValue({ notificationMessageId: null });

    await runLiveEnd(createEnv(), params, step);

    expect(calls).toEqual([
      "sleepUntil:wait for the publisher to reconnect:1700000060000",
      "do:end the live",
    ]);
    expect(mocks.deleteLiveStartedNotification).not.toHaveBeenCalled();
  });

  it.each([429, 500, 503])(
    "lets Workflows retry a notification delete that failed with %i",
    async (status) => {
      const { step } = createStep();
      const doSpy = vi.spyOn(step, "do");
      mocks.endLive.mockResolvedValue({ notificationMessageId: 9n });
      mocks.deleteLiveStartedNotification.mockRejectedValue(
        discordError(status),
      );

      await runLiveEnd(createEnv(), params, step);

      await expect(doSpy.mock.results[1]?.value).rejects.toBeInstanceOf(
        DiscordWebhookError,
      );
      expect(console.warn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          event: "live_notification.delete_failed",
          messageId: "9",
          sessionId: "session-1",
          userId: "user-1",
        }),
      );
    },
  );

  it("gives up without retrying when Discord rejects the delete", async () => {
    const { step } = createStep();
    const doSpy = vi.spyOn(step, "do");
    mocks.endLive.mockResolvedValue({ notificationMessageId: 9n });
    mocks.deleteLiveStartedNotification.mockRejectedValue(discordError(404));

    await runLiveEnd(createEnv(), params, step);

    await expect(doSpy.mock.results[1]?.value).resolves.toBe("failed");
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        endpoint: "https://discord.com/api/webhooks/1/[redacted]/messages/9",
        event: "live_notification.delete_failed",
        messageId: "9",
      }),
    );
  });
});
