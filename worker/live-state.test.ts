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

// ランタイムと同じ挙動でアラームを発火させる（実行中は設定解除された状態になる）。
async function fireAlarm({ core, testStorage }: TestCore): Promise<void> {
  await testStorage.storage.deleteAlarm();
  await core.alarm();
}

// 開始通知付きの配信を user-1 / session-1 で開始する。
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
    // 重複した DELETE でも最初の猶予期限が維持される。
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

    // すでに発火途中だったアラームが実行されても、終了対象の配信は見つからない。
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
    // Worker が完了報告をしなかった場合、削除タスクは再度払い出される。
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
    // 新しいインジェストは、終了済みの配信を再開するのではなく新しい配信を開始する。
    await expect(
      core.resumeLive("user-1", "session-1", "session-2", []),
    ).resolves.toBe(false);
    await expect(
      core.insertLive("user-1", "session-2", []),
    ).resolves.not.toBeNull();

    // 終了した配信の通知削除は即座に実行期限を迎える。
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
    // 最終試行は結果の待機のみを行うため、配信終了から 16 分後に削除タスクは破棄される。
    for (const leaseMs of [30_000, 60_000, 120_000, 240_000, 480_000, 30_000]) {
      expect(testStorage.getAlarm()).toBe(now);
      vi.setSystemTime(now);
      // oxlint-disable-next-line no-await-in-loop -- 各試行は直前のリース期限切れ後に順番に行われるため。
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

    // アラームは期限を保存する同じトランザクション内で設定されるため、
    // 片方だけが存在する状態にはならない。
    await expect(core.getLive("user-1")).resolves.toMatchObject({
      graceExpiresAt: null,
    });
    expect(testStorage.getAlarm()).toBeNull();

    // 失敗した呼び出しは完了済みとして記録されない。
    await expect(
      core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS),
    ).resolves.toBe(NOW + GRACE_MS);
    expect(testStorage.getAlarm()).toBe(NOW + GRACE_MS);
  });

  it("does not report a live end if its alarm update rolls back", async () => {
    const { core, testStorage } = createCore();
    await startNotifiedLive(core);
    vi.mocked(console.info).mockClear();
    vi.spyOn(testStorage.storage, "setAlarm").mockRejectedValueOnce(
      new Error("storage unavailable"),
    );

    await expect(core.endLive("user-1", "session-1")).rejects.toThrow(
      "storage unavailable",
    );

    expect(console.info).not.toHaveBeenCalled();
    await expect(core.getLive("user-1")).resolves.not.toBeNull();
    expect(testStorage.getAlarm()).toBeNull();

    await expect(core.endLive("user-1", "session-1")).resolves.toBe(true);
    expect(console.info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event: "live.ended", userId: "user-1" }),
    );
  });

  it("rejects an invalid notification id without poisoning later calls", async () => {
    const { core, testStorage } = createCore();
    const broadcastId = await core.insertLive("user-1", "session-1", []);
    if (broadcastId === null) {
      throw new Error("Expected a new broadcast");
    }

    await expect(
      core.setLiveNotificationMessageId("user-1", broadcastId, "bad-id"),
    ).rejects.toThrow("Invalid lives.notification_message_id");

    await expect(core.getLive("user-1")).resolves.not.toBeNull();
    await expect(
      core.setLiveToken("user-1", "token-hash"),
    ).resolves.toBeUndefined();
    expect(testStorage.getAlarm()).toBeNull();
  });

  it("leaves nothing behind when a command fails halfway", async () => {
    const { core, testStorage } = createCore();
    await startNotifiedLive(core);
    // この配信を終了させると行が削除され、その後に保存されていた ID が拒否される。
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

  it("uses the stored alarm after a restart", async () => {
    const testStorage = createTestStorage();
    const first = createCore(testStorage);
    await first.core.setUser({ userId: "user-1", displayName: "Streamer" });
    await first.core.insertLive("user-1", "session-1", []);

    // 再起動されたオブジェクトはストレージを保持するが、以前把握していたアラーム情報は保持しない。
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
    expect(setAlarm).toHaveBeenCalledTimes(1);
    // 状態が変化していなければアラームを再設定しない。
    await waiting.core.getLive("user-1");
    expect(setAlarm).toHaveBeenCalledTimes(1);
  });

  it("restores a missing alarm while its deadline is still pending", async () => {
    const { core, testStorage } = createCore();
    await core.insertLive("user-1", "session-1", []);
    await core.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);
    await testStorage.storage.deleteAlarm();

    await core.getLive("user-1");

    expect(testStorage.getAlarm()).toBe(NOW + GRACE_MS);
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
