import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
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
import { LiveEffects } from "../live/effects";
import type { LiveState } from "./live-state";

/** 実際のアラームが自動発火しないよう、テストの時計は遠い未来に置く。 */
const NOW = Date.UTC(2100, 0, 1);
const GRACE_MS = 60_000;

type LiveStateStub = DurableObjectStub<LiveState>;

/** テストごとに空のストレージを持つ新しいオブジェクト。 */
function createLiveState(): LiveStateStub {
  return env.LIVE_STATE.get(env.LIVE_STATE.newUniqueId());
}

/**
 * スタブの RPC 呼び出しが返す Promise は関数でもあり、expect(...).rejects はそれを
 * 呼び出してしまうため、通常の Promise に包んでから検証する。
 */
async function asPromise<T>(call: PromiseLike<T>): Promise<T> {
  return call;
}

async function getAlarm(stub: LiveStateStub): Promise<number | null> {
  return runInDurableObject(stub, async (_instance, state) =>
    state.storage.getAlarm(),
  );
}

/** 次のアラーム設定だけをストレージ障害として失敗させる。 */
async function failNextSetAlarm(stub: LiveStateStub): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    vi.spyOn(state.storage, "setAlarm").mockRejectedValueOnce(
      new Error("storage unavailable"),
    );
  });
}

/** 開始通知付きの配信を user-1 / session-1 で開始する。 */
async function startNotifiedLive(stub: LiveStateStub): Promise<void> {
  const broadcastId = await stub.insertLive("user-1", "session-1", []);
  assert.isNotNull(broadcastId, "Expected a new broadcast");
  await stub.setLiveNotificationMessageId("user-1", broadcastId, "9");
}

describe("live state", () => {
  /**
   * オブジェクトが開始通知の削除を引き渡す LiveEffects エントリーポイント。実際の削除処理は
   * ../live/effects.test.ts で検証する。
   */
  let dispatch: MockInstance<LiveEffects["deleteStartNotifications"]>;
  // テストランナーの console はアクセスのたびに別の関数を返すため、スパイは戻り値で参照する。
  let info: MockInstance<Console["info"]>;
  let warn: MockInstance<Console["warn"]>;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    dispatch = vi
      .spyOn(LiveEffects.prototype, "deleteStartNotifications")
      .mockImplementation(() => undefined);
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sets the alarm to the deadline of a new grace period", async () => {
    const stub = createLiveState();
    await stub.insertLive("user-1", "session-1", []);
    await expect(getAlarm(stub)).resolves.toBeNull();

    await expect(
      stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS),
    ).resolves.toBe(NOW + GRACE_MS);

    await expect(getAlarm(stub)).resolves.toBe(NOW + GRACE_MS);
    await expect(stub.getLive("user-1")).resolves.toMatchObject({
      graceExpiresAt: NOW + GRACE_MS,
      sessionId: "session-1",
    });
  });

  it("refuses a grace period for a session that is not live", async () => {
    const stub = createLiveState();
    await stub.insertLive("user-1", "session-1", []);

    await expect(
      stub.startLiveReconnectGrace("user-1", "other-session", GRACE_MS),
    ).resolves.toBeNull();
    await expect(getAlarm(stub)).resolves.toBeNull();

    await stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);
    vi.setSystemTime(NOW + 1000);
    // 重複した DELETE でも最初の猶予期限が維持される。
    await expect(
      stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS),
    ).resolves.toBeNull();
    await expect(getAlarm(stub)).resolves.toBe(NOW + GRACE_MS);
  });

  it("clears the alarm when the publisher resumes the broadcast", async () => {
    const stub = createLiveState();
    await startNotifiedLive(stub);
    await stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);

    await expect(
      stub.resumeLive("user-1", "session-1", "session-2", []),
    ).resolves.toBe(true);

    await expect(getAlarm(stub)).resolves.toBeNull();
    await expect(stub.getLive("user-1")).resolves.toMatchObject({
      graceExpiresAt: null,
      sessionId: "session-2",
    });

    // 再開前にすでに発火していたアラームハンドラーが実行されても、終了対象の配信は見つからない。
    vi.setSystemTime(NOW + GRACE_MS);
    await runInDurableObject(stub, async (instance: LiveState) =>
      instance.alarm(),
    );
    await expect(stub.getLive("user-1")).resolves.not.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("ends the broadcast at its deadline and hands its notification to the Worker", async () => {
    const stub = createLiveState();
    await startNotifiedLive(stub);
    await stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);

    vi.setSystemTime(NOW + GRACE_MS);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await expect(stub.getLive("user-1")).resolves.toBeNull();
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "9", userId: "user-1" },
    ]);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "live.ended",
        reason: "reconnect_grace_expired",
        sessionId: "session-1",
        userId: "user-1",
      }),
    );
    await expect(getAlarm(stub)).resolves.toBeNull();
  });

  it("does not wake the Worker for a broadcast without a notification", async () => {
    const stub = createLiveState();
    await stub.insertLive("user-1", "session-1", []);
    await stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);

    vi.setSystemTime(NOW + GRACE_MS);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    await expect(stub.getLive("user-1")).resolves.toBeNull();
    expect(dispatch).not.toHaveBeenCalled();
    await expect(getAlarm(stub)).resolves.toBeNull();
  });

  it("keeps a broadcast listed until its grace period passes, even if the alarm is late", async () => {
    const stub = createLiveState();
    await stub.setUser({ userId: "user-1", displayName: "Streamer" });
    await startNotifiedLive(stub);
    await stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);

    vi.setSystemTime(NOW + GRACE_MS - 1);
    await expect(stub.getAllLives()).resolves.toEqual([
      { owner: { userId: "user-1", displayName: "Streamer" } },
    ]);

    vi.setSystemTime(NOW + GRACE_MS + 5000);
    await expect(stub.getAllLives()).resolves.toEqual([]);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "9", userId: "user-1" },
    ]);
    await expect(stub.getLive("user-1")).resolves.toBeNull();
    // 新しいインジェストは、終了済みの配信を再開するのではなく新しい配信を開始する。
    await expect(
      stub.resumeLive("user-1", "session-1", "session-2", []),
    ).resolves.toBe(false);
    await expect(
      stub.insertLive("user-1", "session-2", []),
    ).resolves.not.toBeNull();
    await expect(getAlarm(stub)).resolves.toBeNull();
  });

  it("ends a broadcast whose session was found inactive", async () => {
    const stub = createLiveState();
    await startNotifiedLive(stub);

    await expect(stub.endLive("user-1", "other-session")).resolves.toBe(false);
    await expect(stub.endLive("user-1", "session-1")).resolves.toBe(true);

    await expect(stub.getLive("user-1")).resolves.toBeNull();
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "live.ended",
        reason: "session_inactive",
        sessionId: "session-1",
        userId: "user-1",
      }),
    );
    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "9", userId: "user-1" },
    ]);
    await expect(getAlarm(stub)).resolves.toBeNull();
  });

  it("does not end a broadcast that is waiting for the publisher", async () => {
    const stub = createLiveState();
    await stub.insertLive("user-1", "session-1", []);
    await stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);

    await expect(stub.endLive("user-1", "session-1")).resolves.toBe(false);
    await expect(stub.getLive("user-1")).resolves.not.toBeNull();
  });

  it("hands a notification to the Worker when its broadcast already ended", async () => {
    const stub = createLiveState();

    await expect(
      stub.setLiveNotificationMessageId("user-1", "ended-broadcast", "7"),
    ).resolves.toBe(false);

    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "7", userId: "user-1" },
    ]);
    await expect(getAlarm(stub)).resolves.toBeNull();
  });

  it("ends the broadcast and gives up on its notification when the Worker cannot be reached", async () => {
    const stub = createLiveState();
    await startNotifiedLive(stub);
    dispatch.mockImplementationOnce(() => {
      throw new Error("worker unavailable");
    });

    await expect(stub.endLive("user-1", "session-1")).resolves.toBe(true);

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        errorMessage: "worker unavailable",
        event: "live_notification.delete_dispatch_failed",
        messageIds: ["9"],
      }),
    );
    await expect(stub.getLive("user-1")).resolves.toBeNull();
    await expect(getAlarm(stub)).resolves.toBeNull();
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("wakes for the earliest of several deadlines", async () => {
    const stub = createLiveState();
    await stub.insertLive("user-1", "session-1", []);
    await stub.insertLive("user-2", "session-2", []);
    await stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);
    await stub.startLiveReconnectGrace("user-2", "session-2", 30_000);
    await expect(getAlarm(stub)).resolves.toBe(NOW + 30_000);

    vi.setSystemTime(NOW + 30_000);
    await runDurableObjectAlarm(stub);

    await expect(stub.getLive("user-2")).resolves.toBeNull();
    await expect(stub.getLive("user-1")).resolves.not.toBeNull();
    await expect(getAlarm(stub)).resolves.toBe(NOW + GRACE_MS);
  });

  it("does not store a deadline whose alarm could not be set", async () => {
    const stub = createLiveState();
    await stub.insertLive("user-1", "session-1", []);
    await failNextSetAlarm(stub);

    await expect(
      asPromise(stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS)),
    ).rejects.toThrow("storage unavailable");

    // アラームは期限を保存する同じトランザクション内で設定されるため、
    // 片方だけが存在する状態にはならない。
    await expect(stub.getLive("user-1")).resolves.toMatchObject({
      graceExpiresAt: null,
    });
    await expect(getAlarm(stub)).resolves.toBeNull();

    // 失敗した呼び出しは完了済みとして記録されない。
    await expect(
      stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS),
    ).resolves.toBe(NOW + GRACE_MS);
    await expect(getAlarm(stub)).resolves.toBe(NOW + GRACE_MS);
  });

  it("does not report or hand off a live end if its alarm update rolls back", async () => {
    const stub = createLiveState();
    await startNotifiedLive(stub);
    await stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);
    info.mockClear();
    await runInDurableObject(stub, (_instance, state) => {
      vi.spyOn(state.storage, "deleteAlarm").mockRejectedValueOnce(
        new Error("storage unavailable"),
      );
    });
    vi.setSystemTime(NOW + GRACE_MS);

    await expect(asPromise(stub.getAllLives())).rejects.toThrow(
      "storage unavailable",
    );

    expect(info).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    await expect(getAlarm(stub)).resolves.toBe(NOW + GRACE_MS);

    await expect(stub.getLive("user-1")).resolves.toBeNull();
    expect(info).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ event: "live.ended", userId: "user-1" }),
    );
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("rejects an invalid notification id without poisoning later calls", async () => {
    const stub = createLiveState();
    const broadcastId = await stub.insertLive("user-1", "session-1", []);
    assert.isNotNull(broadcastId, "Expected a new broadcast");

    await expect(
      asPromise(
        stub.setLiveNotificationMessageId("user-1", broadcastId, "bad-id"),
      ),
    ).rejects.toThrow("Invalid lives.notification_message_id");

    await expect(stub.getLive("user-1")).resolves.not.toBeNull();
    await expect(
      stub.setLiveToken("user-1", "token-hash"),
    ).resolves.toBeUndefined();
    await expect(getAlarm(stub)).resolves.toBeNull();
  });

  it("leaves nothing behind when a command fails halfway", async () => {
    const stub = createLiveState();
    await startNotifiedLive(stub);
    // この配信を終了させると行が削除され、その後に保存されていた ID が拒否される。
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE lives SET notification_message_id = 'not-an-id'",
      );
    });

    await expect(
      asPromise(stub.endLive("user-1", "session-1")),
    ).rejects.toThrow("Invalid ended lives row");

    await expect(stub.getLive("user-1")).resolves.toMatchObject({
      sessionId: "session-1",
    });
    await expect(getAlarm(stub)).resolves.toBeNull();
  });

  it("uses the stored alarm after a restart", async () => {
    const stub = createLiveState();
    await stub.setUser({ userId: "user-1", displayName: "Streamer" });
    await stub.insertLive("user-1", "session-1", []);

    // 再起動されたオブジェクトはストレージを保持するが、以前把握していたアラーム情報は保持しない。
    await evictDurableObject(stub);
    const alarmWrites = await runInDurableObject(stub, (_instance, state) => ({
      deleteAlarm: vi.spyOn(state.storage, "deleteAlarm"),
      setAlarm: vi.spyOn(state.storage, "setAlarm"),
    }));
    await expect(stub.getAllLives()).resolves.toEqual([
      { owner: { userId: "user-1", displayName: "Streamer" } },
    ]);
    expect(alarmWrites.setAlarm).not.toHaveBeenCalled();
    expect(alarmWrites.deleteAlarm).not.toHaveBeenCalled();

    await stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);
    expect(alarmWrites.setAlarm).toHaveBeenCalledExactlyOnceWith(
      NOW + GRACE_MS,
    );

    await evictDurableObject(stub);
    const restartedSetAlarm = await runInDurableObject(
      stub,
      (_instance, state) => vi.spyOn(state.storage, "setAlarm"),
    );
    await stub.getLive("user-1");
    // 状態が変化していなければアラームを再設定しない。
    await stub.getLive("user-1");
    expect(restartedSetAlarm).not.toHaveBeenCalled();
    await expect(getAlarm(stub)).resolves.toBe(NOW + GRACE_MS);
  });

  it("restores a missing alarm while its deadline is still pending", async () => {
    const stub = createLiveState();
    await stub.insertLive("user-1", "session-1", []);
    await stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);
    await runInDurableObject(stub, async (_instance, state) =>
      state.storage.deleteAlarm(),
    );

    await stub.getLive("user-1");

    await expect(getAlarm(stub)).resolves.toBe(NOW + GRACE_MS);
  });

  it("records session activity with its own clock, at most once per interval", async () => {
    const stub = createLiveState();
    await stub.insertLive("user-1", "session-1", []);

    await expect(
      stub.markLiveSessionSeenActive("user-1", "session-1", 10_000),
    ).resolves.toBe(true);
    vi.setSystemTime(NOW + 9999);
    await expect(
      stub.markLiveSessionSeenActive("user-1", "session-1", 10_000),
    ).resolves.toBe(false);

    await expect(stub.getLive("user-1")).resolves.toMatchObject({
      sessionSeenActiveAt: NOW,
    });
  });

  it("stores and replaces a user's publisher token", async () => {
    const stub = createLiveState();
    await expect(stub.hasLiveToken("user-1")).resolves.toBe(false);
    await expect(stub.getLiveTokenHash("user-1")).resolves.toBeNull();

    await stub.setLiveToken("user-1", "first-hash");
    await stub.setLiveToken("user-1", "second-hash");

    await expect(stub.getLiveTokenHash("user-1")).resolves.toBe("second-hash");
    await expect(stub.hasLiveToken("user-1")).resolves.toBe(true);
  });
});
