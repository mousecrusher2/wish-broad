import { describe, expect, it, vi } from "vitest";
// oxlint-disable no-await-in-loop -- Each iteration checks a separate D1 fixture.
import {
  deleteLiveForSession,
  getAllLives,
  getLive,
  getLiveTokenHash,
  hasLiveToken,
  insertLive,
  setLiveNotificationMessageId,
  setLiveToken,
  setUser,
} from "./database";

function createDatabase(row: unknown = null, changes = 1) {
  const first = vi.fn<() => Promise<unknown>>().mockResolvedValue(row);
  const run = vi
    .fn<() => Promise<{ meta: { changes: number } }>>()
    .mockResolvedValue({ meta: { changes } });
  const all = vi
    .fn<() => Promise<{ results: unknown }>>()
    .mockResolvedValue({ results: row });
  const bind = vi
    .fn<(...args: unknown[]) => unknown>()
    .mockReturnValue({ first, run, all });
  const prepare = vi
    .fn<(...args: unknown[]) => unknown>()
    .mockReturnValue({ bind, all });
  return {
    // The small mock deliberately implements only the D1 methods exercised here.
    // oxlint-disable-next-line typescript/consistent-type-assertions
    database: { prepare } as unknown as D1Database,
    prepare,
    bind,
    first,
    run,
    all,
  };
}

describe("D1 repository", () => {
  it("inserts a live without replacing an existing session", async () => {
    const db = createDatabase();
    const tracks = [
      {
        location: "remote" as const,
        sessionId: "session",
        trackName: "video",
        mid: "0",
      },
    ];
    await insertLive(db.database, "user", "session", tracks);
    expect(db.prepare).toHaveBeenCalledWith(
      "INSERT INTO lives (user_id, session_id, tracks_json) VALUES (?, ?, ?)",
    );
    expect(db.bind).toHaveBeenCalledWith(
      "user",
      "session",
      JSON.stringify(tracks),
    );
    expect(db.run).toHaveBeenCalledOnce();
  });

  it("validates the stored live row and tracks", async () => {
    const tracks = [
      { location: "remote", sessionId: "s", trackName: "audio", mid: "1" },
    ];
    const db = createDatabase({
      user_id: "u",
      session_id: "s",
      tracks_json: JSON.stringify(tracks),
      notification_message_id: 42,
    });
    expect(await getLive(db.database, "u")).toEqual({
      userId: "u",
      sessionId: "s",
      tracks,
      notificationMessageId: 42n,
    });
    expect(db.prepare).toHaveBeenCalledWith(
      "SELECT user_id, session_id, tracks_json, notification_message_id FROM lives WHERE user_id = ?",
    );
    expect(db.bind).toHaveBeenCalledWith("u");

    for (const messageId of [null, undefined]) {
      const withoutNotification = createDatabase({
        user_id: "u",
        session_id: "s",
        tracks_json: "[]",
        notification_message_id: messageId,
      });
      expect(await getLive(withoutNotification.database, "u")).toMatchObject({
        notificationMessageId: null,
        tracks: [],
      });
    }
    expect(await getLive(createDatabase().database, "u")).toBeNull();
    await expect(
      getLive(createDatabase({ user_id: 3 }).database, "u"),
    ).rejects.toThrow("Invalid D1 lives row");
    await expect(
      getLive(
        createDatabase({
          user_id: "u",
          session_id: "s",
          tracks_json: "not json",
        }).database,
        "u",
      ),
    ).rejects.toThrow(SyntaxError);
    await expect(
      getLive(
        createDatabase({
          user_id: "u",
          session_id: "s",
          tracks_json: JSON.stringify([{ ...tracks[0], location: "local" }]),
        }).database,
        "u",
      ),
    ).rejects.toThrow("Invalid D1 lives.tracks_json");
  });

  it("updates and deletes only the named live session and reports affected rows", async () => {
    for (const changes of [0, 1]) {
      const db = createDatabase(null, changes);
      expect(
        await setLiveNotificationMessageId(db.database, "u", "s", 123n),
      ).toBe(changes > 0);
      expect(db.prepare).toHaveBeenCalledWith(
        "UPDATE lives SET notification_message_id = ? WHERE user_id = ? AND session_id = ?",
      );
      expect(db.bind).toHaveBeenCalledWith(123n, "u", "s");

      const deletion = createDatabase(null, changes);
      expect(await deleteLiveForSession(deletion.database, "u", "s")).toBe(
        changes > 0,
      );
      expect(deletion.prepare).toHaveBeenCalledWith(
        "DELETE FROM lives WHERE user_id = ? AND session_id = ?",
      );
      expect(deletion.bind).toHaveBeenCalledWith("u", "s");
    }
  });

  it("stores and validates a token hash without exposing a raw token", async () => {
    const db = createDatabase();
    await setLiveToken(db.database, "u", "hash");
    expect(db.prepare).toHaveBeenCalledWith(
      "INSERT OR REPLACE INTO live_tokens (user_id, token_hash) VALUES (?, ?)",
    );
    expect(db.bind).toHaveBeenCalledWith("u", "hash");
    expect(db.run).toHaveBeenCalledOnce();

    const stored = createDatabase({ token_hash: "hash" });
    expect(await getLiveTokenHash(stored.database, "u")).toBe("hash");
    expect(stored.prepare).toHaveBeenCalledWith(
      "SELECT token_hash FROM live_tokens WHERE user_id = ?",
    );
    expect(stored.bind).toHaveBeenCalledWith("u");
    expect(await getLiveTokenHash(createDatabase().database, "u")).toBeNull();
    await expect(
      getLiveTokenHash(createDatabase({ token_hash: 42 }).database, "u"),
    ).rejects.toThrow("Invalid D1 live_tokens row");
    const present = createDatabase({ 1: 1 });
    expect(await hasLiveToken(present.database, "u")).toBe(true);
    expect(present.prepare).toHaveBeenCalledWith(
      "SELECT 1 FROM live_tokens WHERE user_id = ? LIMIT 1",
    );
    expect(await hasLiveToken(createDatabase().database, "u")).toBe(false);
  });

  it("stores users and maps the joined live list", async () => {
    const db = createDatabase();
    await setUser(db.database, { userId: "u", displayName: "Alice" });
    expect(db.prepare).toHaveBeenCalledWith(
      "INSERT OR REPLACE INTO users (user_id, display_name) VALUES (?, ?)",
    );
    expect(db.bind).toHaveBeenCalledWith("u", "Alice");
    expect(db.run).toHaveBeenCalledOnce();

    const list = createDatabase([{ user_id: "u", display_name: "Alice" }]);
    expect(await getAllLives(list.database)).toEqual([
      { owner: { userId: "u", displayName: "Alice" } },
    ]);
    expect(list.prepare).toHaveBeenCalledWith(
      "SELECT users.user_id, display_name FROM lives JOIN users ON lives.user_id = users.user_id",
    );
    await expect(
      getAllLives(
        createDatabase([{ user_id: 2, display_name: "Alice" }]).database,
      ),
    ).rejects.toThrow("Invalid D1 live list row");
  });
});
