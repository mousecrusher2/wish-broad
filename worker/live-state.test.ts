import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveStateCore, type NotificationDeleteJob } from "./live-state";
import { createTestStorage } from "./test-doubles";

const NOW = 1_700_000_000_000;
const GRACE_MS = 60_000;

function createCore(testStorage = createTestStorage()) {
  const dispatch = vi
    .fn<(jobs: NotificationDeleteJob[]) => Promise<void>>()
    .mockResolvedValue(undefined);
  const core = new LiveStateCore(
    testStorage.storage,
    { ENVIRONMENT: "production", LOG_LEVEL: "info" },
    dispatch,
  );
  return { core, dispatch, testStorage };
}

type TestCore = ReturnType<typeof createCore>;

// Fires the alarm as the runtime does: it is no longer set while it runs.
async function fireAlarm({ core, testStorage }: TestCore): Promise<void> {
  await testStorage.storage.deleteAlarm();
  await core.alarm();
}

// Starts a broadcast for user-1 on session-1 that has a start notification.
async function startNotifiedLive(core: LiveStateCore): Promise<void> {
  const broadcastId = await core.insertLive("user-1", "session-1", []);
  if (broadcastId === null) {
    throw new Error("Expected a new broadcast");
  }
  await core.setLiveNotificationMessageId("user-1", broadcastId, "9");
}

describe("live state", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets the alarm to the deadline of a new grace period", async () => {
    const { core, testStorage } = createCore();
    await core.insertLive("user-1", "session-1", []);
    expect(testStorage.getAlarm()).toBeNull();

    await expect(
      core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS),
    ).resolves.toBe(NOW + GRACE_MS);

    expect(testStorage.getAlarm()).toBe(NOW + GRACE_MS);
    await expect(core.getLive("user-1")).resolves.toMatchObject({
      graceExpiresAt: NOW + GRACE_MS,
      sessionId: "session-1",
    });
  });

  it("refuses a grace period for a session that is not live", async () => {
    const { core, testStorage } = createCore();
    await core.insertLive("user-1", "session-1", []);

    await expect(
      core.startLiveReconnectGrace("user-1", "other-session", GRACE_MS),
    ).resolves.toBeNull();
    expect(testStorage.getAlarm()).toBeNull();

    await core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);
    vi.setSystemTime(NOW + 1000);
    // A repeated DELETE keeps the first deadline.
    await expect(
      core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS),
    ).resolves.toBeNull();
    expect(testStorage.getAlarm()).toBe(NOW + GRACE_MS);
  });

  it("clears the alarm when the publisher resumes the broadcast", async () => {
    const live = createCore();
    const { core, dispatch, testStorage } = live;
    await startNotifiedLive(core);
    await core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);

    await expect(
      core.resumeLive("user-1", "session-1", "session-2", []),
    ).resolves.toBe(true);

    expect(testStorage.getAlarm()).toBeNull();
    await expect(core.getLive("user-1")).resolves.toMatchObject({
      graceExpiresAt: null,
      sessionId: "session-2",
    });

    // An alarm that was already on its way finds nothing to end.
    vi.setSystemTime(NOW + GRACE_MS);
    await fireAlarm(live);
    await expect(core.getLive("user-1")).resolves.not.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ends the broadcast at its deadline and hands its notification to the Worker", async () => {
    const live = createCore();
    const { core, dispatch, testStorage } = live;
    await startNotifiedLive(core);
    await core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);

    vi.setSystemTime(NOW + GRACE_MS);
    await fireAlarm(live);

    await expect(core.getLive("user-1")).resolves.toBeNull();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "9", userId: "user-1" },
    ]);
    expect(console.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "live.ended",
        reason: "reconnect_grace_expired",
        sessionId: "session-1",
        userId: "user-1",
      }),
    );
    // The delete is handed out again if the Worker does not settle it.
    expect(testStorage.getAlarm()).toBe(NOW + GRACE_MS + 30_000);
  });

  it("does not wake the Worker for a broadcast without a notification", async () => {
    const live = createCore();
    const { core, dispatch, testStorage } = live;
    await core.insertLive("user-1", "session-1", []);
    await core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);

    vi.setSystemTime(NOW + GRACE_MS);
    await fireAlarm(live);

    await expect(core.getLive("user-1")).resolves.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    expect(testStorage.getAlarm()).toBeNull();
  });

  it("keeps a broadcast listed until its grace period passes, even if the alarm is late", async () => {
    const live = createCore();
    const { core, dispatch, testStorage } = live;
    await core.setUser({ userId: "user-1", displayName: "Streamer" });
    await startNotifiedLive(core);
    await core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);

    vi.setSystemTime(NOW + GRACE_MS - 1);
    await expect(core.getAllLives()).resolves.toEqual([
      { owner: { userId: "user-1", displayName: "Streamer" } },
    ]);

    vi.setSystemTime(NOW + GRACE_MS + 5000);
    await expect(core.getAllLives()).resolves.toEqual([]);
    await expect(core.getLive("user-1")).resolves.toBeNull();
    // A new ingest starts a new broadcast instead of resuming the ended one.
    await expect(
      core.resumeLive("user-1", "session-1", "session-2", []),
    ).resolves.toBe(false);
    await expect(
      core.insertLive("user-1", "session-2", []),
    ).resolves.not.toBeNull();

    // The notification of the ended broadcast is due at once.
    expect(testStorage.getAlarm()).toBe(NOW + GRACE_MS + 5000);
    await fireAlarm(live);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "9", userId: "user-1" },
    ]);
  });

  it("ends a broadcast whose session was found inactive", async () => {
    const live = createCore();
    const { core, dispatch, testStorage } = live;
    await startNotifiedLive(core);

    await expect(core.endLive("user-1", "other-session")).resolves.toBe(false);
    await expect(core.endLive("user-1", "session-1")).resolves.toBe(true);

    await expect(core.getLive("user-1")).resolves.toBeNull();
    expect(console.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "live.ended",
        reason: "session_inactive",
        sessionId: "session-1",
        userId: "user-1",
      }),
    );
    expect(testStorage.getAlarm()).toBe(NOW);
    await fireAlarm(live);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "9", userId: "user-1" },
    ]);
  });

  it("does not end a broadcast that is waiting for the publisher", async () => {
    const { core } = createCore();
    await core.insertLive("user-1", "session-1", []);
    await core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);

    await expect(core.endLive("user-1", "session-1")).resolves.toBe(false);
    await expect(core.getLive("user-1")).resolves.not.toBeNull();
  });

  it("queues a notification for deletion when its broadcast already ended", async () => {
    const live = createCore();
    const { core, dispatch } = live;

    await expect(
      core.setLiveNotificationMessageId("user-1", "ended-broadcast", "7"),
    ).resolves.toBe(false);

    await fireAlarm(live);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "7", userId: "user-1" },
    ]);
  });

  it("hands out an unsettled delete with a doubling lease and gives up after six attempts", async () => {
    const live = createCore();
    const { core, dispatch, testStorage } = live;
    await startNotifiedLive(core);
    await core.endLive("user-1", "session-1");

    let now = NOW;
    // The last attempt only waits for its result, so the delete is abandoned
    // 16 minutes after the broadcast ended.
    for (const leaseMs of [30_000, 60_000, 120_000, 240_000, 480_000, 30_000]) {
      expect(testStorage.getAlarm()).toBe(now);
      vi.setSystemTime(now);
      // oxlint-disable-next-line no-await-in-loop -- Each attempt follows the previous lease.
      await fireAlarm(live);
      now += leaseMs;
    }
    expect(dispatch).toHaveBeenCalledTimes(6);
    expect(now).toBe(NOW + 16 * 60_000);
    expect(testStorage.getAlarm()).toBe(now);

    vi.setSystemTime(now);
    await fireAlarm(live);

    expect(dispatch).toHaveBeenCalledTimes(6);
    expect(testStorage.getAlarm()).toBeNull();
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        attempts: 6,
        event: "live_notification.delete_abandoned",
        messageId: "9",
        userId: "user-1",
      }),
    );
  });

  it("stops handing out a delete once the Worker settles it", async () => {
    const live = createCore();
    const { core, dispatch, testStorage } = live;
    await startNotifiedLive(core);
    await core.endLive("user-1", "session-1");
    await fireAlarm(live);
    expect(testStorage.getAlarm()).toBe(NOW + 30_000);

    await core.settleNotificationDeletes(["9", "unknown"]);

    expect(testStorage.getAlarm()).toBeNull();
    vi.setSystemTime(NOW + 30_000);
    await fireAlarm(live);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("keeps a delete leased when the Worker cannot be reached", async () => {
    const live = createCore();
    const { core, dispatch, testStorage } = live;
    await startNotifiedLive(core);
    await core.endLive("user-1", "session-1");
    dispatch.mockRejectedValueOnce(new Error("worker unavailable"));

    await expect(fireAlarm(live)).resolves.toBeUndefined();

    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        errorMessage: "worker unavailable",
        event: "live_notification.delete_dispatch_failed",
        messageIds: ["9"],
      }),
    );
    vi.setSystemTime(NOW + 30_000);
    expect(testStorage.getAlarm()).toBe(NOW + 30_000);
    await fireAlarm(live);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("wakes for the earliest of several deadlines", async () => {
    const live = createCore();
    const { core, testStorage } = live;
    await core.insertLive("user-1", "session-1", []);
    await core.insertLive("user-2", "session-2", []);
    await core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);
    await core.startLiveReconnectGrace("user-2", "session-2", 30_000);
    expect(testStorage.getAlarm()).toBe(NOW + 30_000);

    vi.setSystemTime(NOW + 30_000);
    await fireAlarm(live);

    await expect(core.getLive("user-2")).resolves.toBeNull();
    await expect(core.getLive("user-1")).resolves.not.toBeNull();
    expect(testStorage.getAlarm()).toBe(NOW + GRACE_MS);
  });

  it("does not store a deadline whose alarm could not be set", async () => {
    const { core, testStorage } = createCore();
    await core.insertLive("user-1", "session-1", []);
    vi.spyOn(testStorage.storage, "setAlarm").mockRejectedValueOnce(
      new Error("storage unavailable"),
    );

    await expect(
      core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS),
    ).rejects.toThrow("storage unavailable");

    // The alarm is set in the transaction that stores the deadline, so
    // neither exists without the other.
    await expect(core.getLive("user-1")).resolves.toMatchObject({
      graceExpiresAt: null,
    });
    expect(testStorage.getAlarm()).toBeNull();

    // The failed call is not remembered as done.
    await expect(
      core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS),
    ).resolves.toBe(NOW + GRACE_MS);
    expect(testStorage.getAlarm()).toBe(NOW + GRACE_MS);
  });

  it("leaves nothing behind when a command fails halfway", async () => {
    const { core, testStorage } = createCore();
    await startNotifiedLive(core);
    // Ending this broadcast deletes its row and then rejects the stored id.
    testStorage.storage.sql.exec(
      "UPDATE lives SET notification_message_id = 'not-an-id'",
    );

    await expect(core.endLive("user-1", "session-1")).rejects.toThrow(
      "Invalid ended lives row",
    );

    await expect(core.getLive("user-1")).resolves.toMatchObject({
      sessionId: "session-1",
    });
    expect(testStorage.getAlarm()).toBeNull();
  });

  it("sets the alarm again after a restart only when work is pending", async () => {
    const testStorage = createTestStorage();
    const first = createCore(testStorage);
    await first.core.setUser({ userId: "user-1", displayName: "Streamer" });
    await first.core.insertLive("user-1", "session-1", []);

    // A restarted object keeps its storage but not what it knew of the alarm.
    const idle = createCore(testStorage);
    const setAlarm = vi.spyOn(testStorage.storage, "setAlarm");
    const deleteAlarm = vi.spyOn(testStorage.storage, "deleteAlarm");
    await idle.core.getAllLives();
    expect(setAlarm).not.toHaveBeenCalled();
    expect(deleteAlarm).not.toHaveBeenCalled();

    await idle.core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);
    expect(setAlarm).toHaveBeenCalledExactlyOnceWith(NOW + GRACE_MS);

    const waiting = createCore(testStorage);
    await waiting.core.getLive("user-1");
    expect(setAlarm).toHaveBeenCalledTimes(2);
    expect(setAlarm).toHaveBeenLastCalledWith(NOW + GRACE_MS);
    // Unchanged state does not touch the alarm again.
    await waiting.core.getLive("user-1");
    expect(setAlarm).toHaveBeenCalledTimes(2);
  });

  it("records session activity with its own clock, at most once per interval", async () => {
    const { core } = createCore();
    await core.insertLive("user-1", "session-1", []);

    await expect(
      core.markLiveSessionSeenActive("user-1", "session-1", 10_000),
    ).resolves.toBe(true);
    vi.setSystemTime(NOW + 9999);
    await expect(
      core.markLiveSessionSeenActive("user-1", "session-1", 10_000),
    ).resolves.toBe(false);

    await expect(core.getLive("user-1")).resolves.toMatchObject({
      sessionSeenActiveAt: NOW,
    });
  });

  it("stores and replaces a user's publisher token", async () => {
    const { core } = createCore();
    await expect(core.hasLiveToken("user-1")).resolves.toBe(false);
    await expect(core.getLiveTokenHash("user-1")).resolves.toBeNull();

    await core.setLiveToken("user-1", "first-hash");
    await core.setLiveToken("user-1", "second-hash");

    await expect(core.getLiveTokenHash("user-1")).resolves.toBe("second-hash");
    await expect(core.hasLiveToken("user-1")).resolves.toBe(true);
  });
});
