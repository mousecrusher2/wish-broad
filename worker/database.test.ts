import { describe, expect, it, vi, type Mock } from "vitest";
import {
  deleteLiveForSession,
  getAllLives,
  getLive,
  getLiveTokenHash,
  setLiveNotificationMessageId,
} from "./database";

type MockStatement = {
  all: Mock<() => Promise<unknown>>;
  bind: Mock<(...values: unknown[]) => MockStatement>;
  first: Mock<(...values: unknown[]) => Promise<unknown>>;
  run: Mock<(...values: unknown[]) => Promise<unknown>>;
};

function createDatabase() {
  const statement: MockStatement = {
    all: vi.fn<() => Promise<unknown>>(),
    bind: vi.fn<(...values: unknown[]) => MockStatement>(),
    first: vi.fn<(...values: unknown[]) => Promise<unknown>>(),
    run: vi.fn<(...values: unknown[]) => Promise<unknown>>(),
  };
  statement.bind.mockReturnValue(statement);
  const prepare = vi
    .fn<(query: string) => MockStatement>()
    .mockReturnValue(statement);
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- D1's test double supplies only prepare, the method these helpers exercise.
  const database = { prepare } as unknown as D1Database;

  return { database, prepare, statement };
}

const storedTracks = [
  {
    location: "remote",
    mid: "0",
    sessionId: "sfu-session",
    trackName: "camera",
  },
] as const;

describe("D1 database helpers", () => {
  it("returns null for a missing live row", async () => {
    const { database, statement } = createDatabase();
    statement.first.mockResolvedValue(null);

    await expect(getLive(database, "user-1")).resolves.toBeNull();
    expect(statement.bind).toHaveBeenCalledWith("user-1");
  });

  it.each([null, undefined, 123n, 123])(
    "validates and normalizes live rows with notification id %s",
    async (notificationMessageId) => {
      const { database, statement } = createDatabase();
      statement.first.mockResolvedValue({
        notification_message_id: notificationMessageId,
        user_id: "user-1",
        session_id: "session-1",
        tracks_json: JSON.stringify(storedTracks),
      });

      await expect(getLive(database, "user-1")).resolves.toEqual({
        notificationMessageId:
          notificationMessageId === null || notificationMessageId === undefined
            ? null
            : 123n,
        userId: "user-1",
        sessionId: "session-1",
        tracks: storedTracks,
      });
    },
  );

  it("rejects malformed live rows, track JSON, and invalid track records", async () => {
    const { database, statement } = createDatabase();
    statement.first.mockResolvedValue({
      user_id: "user-1",
      session_id: "session-1",
      tracks_json: "[]",
      notification_message_id: "not-an-id",
    });
    await expect(getLive(database, "user-1")).rejects.toThrow(
      "Invalid D1 lives row",
    );

    statement.first.mockResolvedValue({
      user_id: "user-1",
      session_id: "session-1",
      tracks_json: "not-json",
    });
    await expect(getLive(database, "user-1")).rejects.toThrow(SyntaxError);

    statement.first.mockResolvedValue({
      user_id: "user-1",
      session_id: "session-1",
      tracks_json: JSON.stringify([{ ...storedTracks[0], location: "local" }]),
    });
    await expect(getLive(database, "user-1")).rejects.toThrow(
      "Invalid D1 lives.tracks_json",
    );
  });

  it.each([
    [
      "UPDATE lives SET notification_message_id = ? WHERE user_id = ? AND session_id = ?",
      "set",
    ],
    ["DELETE FROM lives WHERE user_id = ? AND session_id = ?", "delete"],
  ] as const)("executes guarded live %s by session", async (sql, operation) => {
    const { database, prepare, statement } = createDatabase();
    statement.run.mockResolvedValue({ meta: { changes: 1 } });

    const result =
      operation === "set"
        ? await setLiveNotificationMessageId(
            database,
            "user-1",
            "session-1",
            45n,
          )
        : await deleteLiveForSession(database, "user-1", "session-1");

    expect(result).toBe(true);
    expect(prepare).toHaveBeenCalledWith(sql);
    expect(statement.bind).toHaveBeenCalledWith(
      ...(operation === "set"
        ? [45n, "user-1", "session-1"]
        : ["user-1", "session-1"]),
    );
  });

  it("returns false when guarded live updates or deletes change no row", async () => {
    const { database, statement } = createDatabase();
    statement.run.mockResolvedValue({ meta: { changes: 0 } });

    await expect(
      setLiveNotificationMessageId(database, "user-1", "old-session", 45n),
    ).resolves.toBe(false);
    await expect(
      deleteLiveForSession(database, "user-1", "old-session"),
    ).resolves.toBe(false);
  });

  it("reads a live token hash, and reports absent tokens", async () => {
    const { database, statement } = createDatabase();
    statement.first.mockResolvedValue({ token_hash: "hashed-token" });
    await expect(getLiveTokenHash(database, "user-1")).resolves.toBe(
      "hashed-token",
    );
    statement.first.mockResolvedValue({ token_hash: 42 });
    await expect(getLiveTokenHash(database, "user-1")).rejects.toThrow(
      "Invalid D1 live_tokens row",
    );
    statement.first.mockResolvedValue(null);
    await expect(getLiveTokenHash(database, "user-1")).resolves.toBeNull();
  });

  it("maps all live rows to owners and rejects invalid list records", async () => {
    const { database, statement } = createDatabase();
    statement.all.mockResolvedValue({
      results: [{ user_id: "user-1", display_name: "Streamer" }],
    });
    await expect(getAllLives(database)).resolves.toEqual([
      { owner: { userId: "user-1", displayName: "Streamer" } },
    ]);

    statement.all.mockResolvedValue({ results: [{ user_id: "user-1" }] });
    await expect(getAllLives(database)).rejects.toThrow(
      "Invalid D1 live list row",
    );
  });
});
