import { beforeEach, describe, expect, it } from "vitest";
import {
  endLive,
  endOverdueLives,
  enqueueNotificationDelete,
  getAllLives,
  getDueNotificationDeletes,
  getLive,
  getLiveTokenHash,
  getNextWakeAt,
  hasLiveToken,
  insertLive,
  leaseNotificationDelete,
  markLiveSessionSeenActive,
  migrateSchema,
  removeNotificationDelete,
  resumeLive,
  setLiveNotificationMessageId,
  setLiveToken,
  setUser,
  type Sql,
  startLiveReconnectGrace,
} from "./database";
import { createTestStorage } from "./test-doubles";

const NOW = 1_700_000_000_000;

function createTracks(sessionId: string) {
  return [
    {
      location: "remote",
      mid: "0",
      sessionId,
      trackName: "camera",
    },
  ];
}

// Stores a row that the typed helpers would never write.
function insertRawLive(sql: Sql, overrides: Record<string, string>): void {
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
  sql.exec(
    `INSERT OR REPLACE INTO lives (${Object.keys(columns).join(", ")}) VALUES (${Object.values(columns).join(", ")})`,
  );
}

describe("live state SQL", () => {
  let sql: Sql;

  beforeEach(() => {
    ({ sql } = createTestStorage().storage);
    migrateSchema(sql);
  });

  it("creates the schema once and keeps stored rows when it runs again", () => {
    setUser(sql, { userId: "user-1", displayName: "Streamer" });

    migrateSchema(sql);

    expect(sql.exec("SELECT version FROM schema_migrations").toArray()).toEqual(
      [{ version: 1 }],
    );
    expect(sql.exec("SELECT display_name FROM users").toArray()).toEqual([
      { display_name: "Streamer" },
    ]);
  });

  it("returns null for a missing live row", () => {
    expect(getLive(sql, "user-1")).toBeNull();
  });

  it("starts a broadcast with a fresh broadcast id", () => {
    const tracks = createTracks("session-1");

    const broadcastId = insertLive(sql, "user-1", "session-1", tracks);

    expect(broadcastId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(getLive(sql, "user-1")).toEqual({
      broadcastId,
      graceExpiresAt: null,
      sessionSeenActiveAt: null,
      sessionId: "session-1",
      tracks,
      userId: "user-1",
    });
  });

  it("does not replace the live row of an owner who already has one", () => {
    const broadcastId = insertLive(
      sql,
      "user-1",
      "session-1",
      createTracks("session-1"),
    );

    expect(
      insertLive(sql, "user-1", "session-2", createTracks("session-2")),
    ).toBeNull();
    expect(getLive(sql, "user-1")).toMatchObject({
      broadcastId,
      sessionId: "session-1",
    });
  });

  it("rejects malformed live rows, track JSON, and invalid track records", () => {
    insertRawLive(sql, { grace_expires_at: "1.5" });
    expect(() => getLive(sql, "user-1")).toThrow("Invalid lives row");

    insertRawLive(sql, { session_seen_active_at: "'recent'" });
    expect(() => getLive(sql, "user-1")).toThrow("Invalid lives row");

    insertRawLive(sql, { tracks_json: "'not-json'" });
    expect(() => getLive(sql, "user-1")).toThrow(SyntaxError);

    insertRawLive(sql, {
      tracks_json: `'${JSON.stringify([
        { ...createTracks("session-1")[0], location: "local" },
      ])}'`,
    });
    expect(() => getLive(sql, "user-1")).toThrow("Invalid lives.tracks_json");
  });

  it("stores a notification only on the broadcast it was sent for", () => {
    const broadcastId = insertLive(sql, "user-1", "session-1", []);
    if (broadcastId === null) {
      throw new Error("Expected a new broadcast");
    }

    expect(
      setLiveNotificationMessageId(sql, "user-1", "other-broadcast", "45"),
    ).toBe(false);
    expect(setLiveNotificationMessageId(sql, "user-2", broadcastId, "45")).toBe(
      false,
    );
    expect(setLiveNotificationMessageId(sql, "user-1", broadcastId, "45")).toBe(
      true,
    );
    expect(endLive(sql, "user-1", "session-1")).toEqual({
      notificationMessageId: "45",
      sessionId: "session-1",
      userId: "user-1",
    });
  });

  it("starts a grace period only for the live session that is stored", () => {
    insertLive(sql, "user-1", "session-1", []);

    expect(
      startLiveReconnectGrace(sql, "user-1", "other-session", NOW + 60_000),
    ).toBe(false);
    expect(
      startLiveReconnectGrace(sql, "user-1", "session-1", NOW + 60_000),
    ).toBe(true);
    expect(getLive(sql, "user-1")?.graceExpiresAt).toBe(NOW + 60_000);
    // A repeated DELETE must not extend the deadline.
    expect(
      startLiveReconnectGrace(sql, "user-1", "session-1", NOW + 90_000),
    ).toBe(false);
    expect(getLive(sql, "user-1")?.graceExpiresAt).toBe(NOW + 60_000);
  });

  it("resumes a broadcast with a new session and clears its grace state", () => {
    const broadcastId = insertLive(sql, "user-1", "session-1", []);
    markLiveSessionSeenActive(sql, "user-1", "session-1", NOW, 10_000);
    startLiveReconnectGrace(sql, "user-1", "session-1", NOW + 60_000);
    expect(getLive(sql, "user-1")).toMatchObject({
      graceExpiresAt: NOW + 60_000,
      sessionSeenActiveAt: NOW,
    });
    const tracks = createTracks("session-2");

    expect(
      resumeLive(sql, "user-1", "other-session", "session-2", tracks),
    ).toBe(false);
    expect(resumeLive(sql, "user-1", "session-1", "session-2", tracks)).toBe(
      true,
    );
    expect(getLive(sql, "user-1")).toEqual({
      broadcastId,
      graceExpiresAt: null,
      sessionSeenActiveAt: null,
      sessionId: "session-2",
      tracks,
      userId: "user-1",
    });
  });

  it("records session activity at most once per interval", () => {
    insertLive(sql, "user-1", "session-1", []);

    expect(
      markLiveSessionSeenActive(sql, "user-1", "other-session", NOW, 10_000),
    ).toBe(false);
    expect(
      markLiveSessionSeenActive(sql, "user-1", "session-1", NOW, 10_000),
    ).toBe(true);
    expect(
      markLiveSessionSeenActive(sql, "user-1", "session-1", NOW + 9999, 10_000),
    ).toBe(false);
    expect(getLive(sql, "user-1")?.sessionSeenActiveAt).toBe(NOW);
    expect(
      markLiveSessionSeenActive(
        sql,
        "user-1",
        "session-1",
        NOW + 10_000,
        10_000,
      ),
    ).toBe(true);
    expect(getLive(sql, "user-1")?.sessionSeenActiveAt).toBe(NOW + 10_000);
  });

  it("ends a live only while it holds the observed session outside a grace period", () => {
    insertLive(sql, "user-1", "session-1", []);

    expect(endLive(sql, "user-1", "other-session")).toBeNull();
    expect(endLive(sql, "user-1", "session-1")).toEqual({
      notificationMessageId: null,
      sessionId: "session-1",
      userId: "user-1",
    });
    expect(getLive(sql, "user-1")).toBeNull();

    insertLive(sql, "user-1", "session-2", []);
    startLiveReconnectGrace(sql, "user-1", "session-2", NOW + 60_000);
    expect(endLive(sql, "user-1", "session-2")).toBeNull();
    expect(getLive(sql, "user-1")).not.toBeNull();
  });

  it("rejects an ended live whose stored notification id is not decimal text", () => {
    insertRawLive(sql, { notification_message_id: "'not-an-id'" });

    expect(() => endLive(sql, "user-1", "session-1")).toThrow(
      "Invalid ended lives row",
    );
  });

  it("ends exactly the broadcasts whose grace period has passed", () => {
    insertLive(sql, "live-user", "live-session", []);
    insertLive(sql, "waiting-user", "waiting-session", []);
    startLiveReconnectGrace(sql, "waiting-user", "waiting-session", NOW + 1);
    const broadcastId = insertLive(sql, "overdue-user", "overdue-session", []);
    setLiveNotificationMessageId(
      sql,
      "overdue-user",
      String(broadcastId),
      "1300000000000000123",
    );
    startLiveReconnectGrace(sql, "overdue-user", "overdue-session", NOW);

    expect(endOverdueLives(sql, NOW)).toEqual([
      {
        // Larger than Number.MAX_SAFE_INTEGER, like real Discord snowflakes.
        notificationMessageId: "1300000000000000123",
        sessionId: "overdue-session",
        userId: "overdue-user",
      },
    ]);
    expect(getLive(sql, "overdue-user")).toBeNull();
    expect(getLive(sql, "waiting-user")).not.toBeNull();
    expect(getLive(sql, "live-user")).not.toBeNull();
    expect(endOverdueLives(sql, NOW)).toEqual([]);
  });

  it("hands out notification deletes once they are due, oldest first", () => {
    enqueueNotificationDelete(sql, "2", "user-2", NOW + 5);
    enqueueNotificationDelete(sql, "1", "user-1", NOW);
    // The same message is only queued once.
    enqueueNotificationDelete(sql, "1", "user-1", NOW + 99);

    expect(getDueNotificationDeletes(sql, NOW - 1)).toEqual([]);
    expect(getDueNotificationDeletes(sql, NOW)).toEqual([
      { attempts: 0, messageId: "1", userId: "user-1" },
    ]);
    expect(getDueNotificationDeletes(sql, NOW + 5)).toEqual([
      { attempts: 0, messageId: "1", userId: "user-1" },
      { attempts: 0, messageId: "2", userId: "user-2" },
    ]);
  });

  it("hides a leased notification delete until its lease expires", () => {
    enqueueNotificationDelete(sql, "1", "user-1", NOW);

    leaseNotificationDelete(sql, "1", NOW + 30_000);

    expect(getDueNotificationDeletes(sql, NOW + 29_999)).toEqual([]);
    expect(getDueNotificationDeletes(sql, NOW + 30_000)).toEqual([
      { attempts: 1, messageId: "1", userId: "user-1" },
    ]);

    removeNotificationDelete(sql, "1");
    expect(getDueNotificationDeletes(sql, NOW + 30_000)).toEqual([]);
  });

  it("reports the earliest grace deadline or due notification delete", () => {
    insertLive(sql, "live-user", "live-session", []);
    expect(getNextWakeAt(sql)).toBeNull();

    insertLive(sql, "waiting-user", "waiting-session", []);
    startLiveReconnectGrace(sql, "waiting-user", "waiting-session", NOW + 60);
    expect(getNextWakeAt(sql)).toBe(NOW + 60);

    enqueueNotificationDelete(sql, "1", "user-1", NOW + 30);
    expect(getNextWakeAt(sql)).toBe(NOW + 30);

    removeNotificationDelete(sql, "1");
    expect(getNextWakeAt(sql)).toBe(NOW + 60);
  });

  it("keeps one current token hash per user", () => {
    expect(getLiveTokenHash(sql, "user-1")).toBeNull();
    expect(hasLiveToken(sql, "user-1")).toBe(false);

    setLiveToken(sql, "user-1", "first-hash");
    setLiveToken(sql, "user-1", "second-hash");

    expect(getLiveTokenHash(sql, "user-1")).toBe("second-hash");
    expect(hasLiveToken(sql, "user-1")).toBe(true);
    expect(hasLiveToken(sql, "user-2")).toBe(false);
  });

  it("rejects a stored token hash that is not text", () => {
    sql.exec(
      "INSERT INTO live_tokens (user_id, token_hash) VALUES ('user-1', x'00')",
    );

    expect(() => getLiveTokenHash(sql, "user-1")).toThrow(
      "Invalid live_tokens row",
    );
  });

  it("lists lives with their owners' names, including ones waiting for OBS", () => {
    setUser(sql, { userId: "user-1", displayName: "Old name" });
    setUser(sql, { userId: "user-1", displayName: "Streamer" });
    setUser(sql, { userId: "user-2", displayName: "Reconnecting" });
    setUser(sql, { userId: "user-3", displayName: "Offline" });
    insertLive(sql, "user-1", "session-1", []);
    insertLive(sql, "user-2", "session-2", []);
    startLiveReconnectGrace(sql, "user-2", "session-2", NOW + 60_000);

    expect(getAllLives(sql)).toEqual([
      { owner: { userId: "user-1", displayName: "Streamer" } },
      { owner: { userId: "user-2", displayName: "Reconnecting" } },
    ]);
  });
});
