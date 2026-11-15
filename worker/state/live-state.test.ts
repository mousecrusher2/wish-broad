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
import type { StoredTrack } from "../live/types";
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

function createTracks(sessionId: string): StoredTrack[] {
  return [{ location: "remote", mid: "0", sessionId, trackName: "camera" }];
}

/** LiveState のメソッドでは決して書き込まない形式の行を user-1 / session-1 で保存する。 */
async function insertRawLive(
  stub: LiveStateStub,
  overrides: Record<string, string>,
): Promise<void> {
  const columns = {
    broadcast_id: "'broadcast-1'",
    grace_expires_at: "NULL",
    notification_message_id: "NULL",
    session_id: "'session-1'",
    session_seen_active_at: "NULL",
    tracks_json: "'[]'",
    user_id: "'user-1'",
    ...overrides,
  };
  await runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec(
      `INSERT OR REPLACE INTO lives (${Object.keys(columns).join(", ")}) VALUES (${Object.values(columns).join(", ")})`,
    );
  });
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

  it("starts a broadcast with a fresh broadcast id", async () => {
    const stub = createLiveState();
    await expect(stub.getLive("user-1")).resolves.toBeNull();
    const tracks = createTracks("session-1");

    const broadcastId = await stub.insertLive("user-1", "session-1", tracks);

    expect(broadcastId).toMatch(/^[0-9a-f-]{36}$/u);
    await expect(stub.getLive("user-1")).resolves.toEqual({
      broadcastId,
      graceExpiresAt: null,
      sessionSeenActiveAt: null,
      sessionId: "session-1",
      tracks,
      userId: "user-1",
    });
  });

  it("does not replace the live row of an owner who already has one", async () => {
    const stub = createLiveState();
    const broadcastId = await stub.insertLive("user-1", "session-1", []);

    await expect(
      stub.insertLive("user-1", "session-2", []),
    ).resolves.toBeNull();
    await expect(stub.getLive("user-1")).resolves.toMatchObject({
      broadcastId,
      sessionId: "session-1",
    });
  });

  it("rejects tracks that getLive could not read back", async () => {
    const stub = createLiveState();
    const localTracks = [
      {
        location: "local",
        mid: "0",
        sessionId: "session-2",
        trackName: "camera",
      },
    ];

    await expect(
      asPromise(stub.insertLive("user-1", "session-1", localTracks)),
    ).rejects.toThrow("Invalid lives.tracks_json");
    await expect(stub.getLive("user-1")).resolves.toBeNull();

    const tracks = createTracks("session-1");
    await stub.insertLive("user-1", "session-1", tracks);
    await expect(
      asPromise(
        stub.resumeLive("user-1", "session-1", "session-2", localTracks),
      ),
    ).rejects.toThrow("Invalid lives.tracks_json");
    await expect(stub.getLive("user-1")).resolves.toMatchObject({
      sessionId: "session-1",
      tracks,
    });
  });

  it("rejects malformed live rows, track JSON, and invalid track records", async () => {
    const stub = createLiveState();

    // 期限切れの配信として先に終了されないよう、猶予期限は現在時刻より後に置く。
    await insertRawLive(stub, {
      grace_expires_at: String(NOW + GRACE_MS + 0.5),
    });
    await expect(asPromise(stub.getLive("user-1"))).rejects.toThrow(
      "Invalid lives row",
    );

    await insertRawLive(stub, { session_seen_active_at: "'recent'" });
    await expect(asPromise(stub.getLive("user-1"))).rejects.toThrow(
      "Invalid lives row",
    );

    await insertRawLive(stub, { tracks_json: "'not-json'" });
    await expect(asPromise(stub.getLive("user-1"))).rejects.toThrow(
      SyntaxError,
    );

    await insertRawLive(stub, {
      tracks_json: `'${JSON.stringify([
        { ...createTracks("session-1")[0], location: "local" },
      ])}'`,
    });
    await expect(asPromise(stub.getLive("user-1"))).rejects.toThrow(
      "Invalid lives.tracks_json",
    );
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

  it("resumes a broadcast with a new session and clears its grace state", async () => {
    const stub = createLiveState();
    const broadcastId = await stub.insertLive("user-1", "session-1", []);
    await stub.markLiveSessionSeenActive("user-1", "session-1", 10_000);
    await stub.startLiveReconnectGrace("user-1", "session-1", GRACE_MS);
    await expect(stub.getLive("user-1")).resolves.toMatchObject({
      graceExpiresAt: NOW + GRACE_MS,
      sessionSeenActiveAt: NOW,
    });
    const tracks = createTracks("session-2");

    await expect(
      stub.resumeLive("user-1", "other-session", "session-2", tracks),
    ).resolves.toBe(false);
    await expect(
      stub.resumeLive("user-1", "session-1", "session-2", tracks),
    ).resolves.toBe(true);
    await expect(stub.getLive("user-1")).resolves.toEqual({
      broadcastId,
      graceExpiresAt: null,
      sessionSeenActiveAt: null,
      sessionId: "session-2",
      tracks,
      userId: "user-1",
    });
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

  it("lists lives with their owners' names, including ones waiting for OBS", async () => {
    const stub = createLiveState();
    await stub.setUser({ userId: "user-1", displayName: "Old name" });
    await stub.setUser({ userId: "user-1", displayName: "Streamer" });
    await stub.setUser({ userId: "user-2", displayName: "Reconnecting" });
    await stub.setUser({ userId: "user-3", displayName: "Offline" });
    await stub.insertLive("user-1", "session-1", []);
    await stub.insertLive("user-2", "session-2", []);
    await stub.startLiveReconnectGrace("user-2", "session-2", GRACE_MS);

    await expect(stub.getAllLives()).resolves.toEqual([
      { owner: { userId: "user-1", displayName: "Streamer" } },
      { owner: { userId: "user-2", displayName: "Reconnecting" } },
    ]);
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

  it("stores a notification only on the broadcast it was sent for", async () => {
    const stub = createLiveState();
    const broadcastId = await stub.insertLive("user-1", "session-1", []);
    assert.isNotNull(broadcastId, "Expected a new broadcast");

    await expect(
      stub.setLiveNotificationMessageId("user-1", "other-broadcast", "45"),
    ).resolves.toBe(false);
    await expect(
      stub.setLiveNotificationMessageId("user-2", broadcastId, "46"),
    ).resolves.toBe(false);
    await expect(
      stub.setLiveNotificationMessageId("user-1", broadcastId, "47"),
    ).resolves.toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(2);
    dispatch.mockClear();

    await stub.endLive("user-1", "session-1");

    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "47", userId: "user-1" },
    ]);
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

  it("ends exactly the broadcasts whose grace period has passed", async () => {
    const stub = createLiveState();
    await stub.insertLive("live-user", "live-session", []);
    await stub.insertLive("waiting-user", "waiting-session", []);
    await stub.startLiveReconnectGrace(
      "waiting-user",
      "waiting-session",
      GRACE_MS,
    );
    const broadcastId = await stub.insertLive(
      "overdue-user",
      "overdue-session",
      [],
    );
    assert.isNotNull(broadcastId, "Expected a new broadcast");
    // 実際の Discord snowflake と同様、Number.MAX_SAFE_INTEGER より大きい値。
    await stub.setLiveNotificationMessageId(
      "overdue-user",
      broadcastId,
      "1300000000000000123",
    );
    await stub.startLiveReconnectGrace(
      "overdue-user",
      "overdue-session",
      30_000,
    );

    vi.setSystemTime(NOW + 30_000);
    await expect(stub.getLive("overdue-user")).resolves.toBeNull();

    expect(dispatch).toHaveBeenCalledExactlyOnceWith([
      { messageId: "1300000000000000123", userId: "overdue-user" },
    ]);
    await expect(stub.getLive("waiting-user")).resolves.not.toBeNull();
    await expect(stub.getLive("live-user")).resolves.not.toBeNull();
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

  it("rejects values that later reads could not parse, without poisoning later calls", async () => {
    const stub = createLiveState();
    const broadcastId = await stub.insertLive("user-1", "session-1", []);
    assert.isNotNull(broadcastId, "Expected a new broadcast");

    await expect(
      asPromise(
        stub.setLiveNotificationMessageId("user-1", broadcastId, "bad-id"),
      ),
    ).rejects.toThrow("Invalid lives.notification_message_id");
    await expect(
      asPromise(stub.startLiveReconnectGrace("user-1", "session-1", 0.5)),
    ).rejects.toThrow("Invalid lives.grace_expires_at");

    await expect(stub.getLive("user-1")).resolves.toMatchObject({
      graceExpiresAt: null,
    });
    await expect(
      stub.setLiveToken("user-1", "token-hash"),
    ).resolves.toBeUndefined();
    await expect(getAlarm(stub)).resolves.toBeNull();
    // 拒否された通知 ID は保存されていないため、終了時に削除も引き渡されない。
    await expect(stub.endLive("user-1", "session-1")).resolves.toBe(true);
    expect(dispatch).not.toHaveBeenCalled();
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
      stub.markLiveSessionSeenActive("user-1", "other-session", 10_000),
    ).resolves.toBe(false);
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

    vi.setSystemTime(NOW + 10_000);
    await expect(
      stub.markLiveSessionSeenActive("user-1", "session-1", 10_000),
    ).resolves.toBe(true);
    await expect(stub.getLive("user-1")).resolves.toMatchObject({
      sessionSeenActiveAt: NOW + 10_000,
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
    await expect(stub.hasLiveToken("user-2")).resolves.toBe(false);
  });

  it("rejects a stored token hash that is not text", async () => {
    const stub = createLiveState();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO live_tokens (user_id, token_hash) VALUES ('user-1', x'00')",
      );
    });

    await expect(asPromise(stub.getLiveTokenHash("user-1"))).rejects.toThrow(
      "Invalid live_tokens row",
    );
  });
});
