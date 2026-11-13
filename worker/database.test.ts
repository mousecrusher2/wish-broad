import { describe, expect, it, vi, type Mock } from "vitest";
import {
  endLive,
  getAllLives,
  getLive,
  getLiveTokenHash,
  insertLive,
  markLiveSessionSeenActive,
  resumeLive,
  setLiveNotificationMessageId,
  startLiveReconnectGrace,
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

function createLiveRow(overrides: Record<string, unknown> = {}) {
  return {
    broadcast_id: "broadcast-1",
    grace_expires_at: null,
    notification_message_id: null,
    session_id: "session-1",
    session_seen_active_at: null,
    tracks_json: JSON.stringify(storedTracks),
    user_id: "user-1",
    ...overrides,
  };
}

describe("D1 database helpers", () => {
  it("returns null for a missing live row", async () => {
    const { database, statement } = createDatabase();
    statement.first.mockResolvedValue(null);

    await expect(getLive(database, "user-1")).resolves.toBeNull();
    expect(statement.bind).toHaveBeenCalledWith("user-1");
  });

  it.each([
    [null, null, null, null],
    // Larger than Number.MAX_SAFE_INTEGER, like real Discord snowflakes.
    [
      "1300000000000000123",
      1_300_000_000_000_000_123n,
      1_700_000_060_000,
      1_700_000_000_000,
    ],
  ] as const)(
    "validates and normalizes live rows with notification id %s",
    async (
      storedMessageId,
      notificationMessageId,
      graceExpiresAt,
      sessionSeenActiveAt,
    ) => {
      const { database, statement } = createDatabase();
      statement.first.mockResolvedValue(
        createLiveRow({
          grace_expires_at: graceExpiresAt,
          notification_message_id: storedMessageId,
          session_seen_active_at: sessionSeenActiveAt,
        }),
      );

      await expect(getLive(database, "user-1")).resolves.toEqual({
        broadcastId: "broadcast-1",
        graceExpiresAt,
        notificationMessageId,
        sessionSeenActiveAt,
        userId: "user-1",
        sessionId: "session-1",
        tracks: storedTracks,
      });
    },
  );

  it.each(["not-an-id", "", 123, 123n])(
    "rejects a stored notification id of %s that is not decimal text",
    async (storedMessageId) => {
      const { database, statement } = createDatabase();
      statement.first.mockResolvedValue(
        createLiveRow({ notification_message_id: storedMessageId }),
      );

      await expect(getLive(database, "user-1")).rejects.toThrow(
        "Invalid D1 lives row",
      );
    },
  );

  it("rejects malformed live rows, track JSON, and invalid track records", async () => {
    const { database, statement } = createDatabase();
    statement.first.mockResolvedValue({
      user_id: "user-1",
      session_id: "session-1",
      tracks_json: "[]",
    });
    await expect(getLive(database, "user-1")).rejects.toThrow(
      "Invalid D1 lives row",
    );

    statement.first.mockResolvedValue(createLiveRow({ grace_expires_at: 1.5 }));
    await expect(getLive(database, "user-1")).rejects.toThrow(
      "Invalid D1 lives row",
    );

    statement.first.mockResolvedValue(
      createLiveRow({ session_seen_active_at: "recent" }),
    );
    await expect(getLive(database, "user-1")).rejects.toThrow(
      "Invalid D1 lives row",
    );

    statement.first.mockResolvedValue(
      createLiveRow({ tracks_json: "not-json" }),
    );
    await expect(getLive(database, "user-1")).rejects.toThrow(SyntaxError);

    statement.first.mockResolvedValue(
      createLiveRow({
        tracks_json: JSON.stringify([
          { ...storedTracks[0], location: "local" },
        ]),
      }),
    );
    await expect(getLive(database, "user-1")).rejects.toThrow(
      "Invalid D1 lives.tracks_json",
    );
  });

  it("starts a broadcast with a fresh broadcast id", async () => {
    const { database, prepare, statement } = createDatabase();
    statement.run.mockResolvedValue({ meta: { changes: 1 } });

    const broadcastId = await insertLive(database, "user-1", "session-1", [
      ...storedTracks,
    ]);

    expect(broadcastId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(prepare).toHaveBeenCalledWith(
      "INSERT INTO lives (user_id, broadcast_id, session_id, tracks_json) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING",
    );
    expect(statement.bind).toHaveBeenCalledWith(
      "user-1",
      broadcastId,
      "session-1",
      JSON.stringify(storedTracks),
    );
  });

  it("does not start a broadcast when the owner already has a live row", async () => {
    const { database, statement } = createDatabase();
    statement.run.mockResolvedValue({ meta: { changes: 0 } });

    await expect(
      insertLive(database, "user-1", "session-1", [...storedTracks]),
    ).resolves.toBeNull();
  });

  it.each([
    [
      "notification",
      "UPDATE lives SET notification_message_id = ? WHERE user_id = ? AND broadcast_id = ?",
      ["45", "user-1", "broadcast-1"],
    ],
    [
      "grace",
      "UPDATE lives SET grace_expires_at = ? WHERE user_id = ? AND session_id = ? AND grace_expires_at IS NULL",
      [1_700_000_060_000, "user-1", "session-1"],
    ],
    [
      "resume",
      "UPDATE lives SET session_id = ?, tracks_json = ?, grace_expires_at = NULL, session_seen_active_at = NULL WHERE user_id = ? AND session_id = ?",
      ["session-2", JSON.stringify(storedTracks), "user-1", "session-1"],
    ],
    [
      "seen active",
      "UPDATE lives SET session_seen_active_at = ? WHERE user_id = ? AND session_id = ? AND (session_seen_active_at IS NULL OR session_seen_active_at <= ?)",
      [1_700_000_000_000, "user-1", "session-1", 1_699_999_990_000],
    ],
  ] as const)(
    "executes the guarded live %s update",
    async (operation, sql, bindings) => {
      const { database, prepare, statement } = createDatabase();
      statement.run.mockResolvedValue({ meta: { changes: 1 } });
      const run = {
        grace: () =>
          startLiveReconnectGrace(
            database,
            "user-1",
            "session-1",
            1_700_000_060_000,
          ),
        notification: () =>
          setLiveNotificationMessageId(database, "user-1", "broadcast-1", 45n),
        resume: () =>
          resumeLive(database, "user-1", "session-1", "session-2", [
            ...storedTracks,
          ]),
        "seen active": () =>
          markLiveSessionSeenActive(
            database,
            "user-1",
            "session-1",
            1_700_000_000_000,
            10_000,
          ),
      }[operation];

      await expect(run()).resolves.toBe(true);
      expect(prepare).toHaveBeenCalledWith(sql);
      expect(statement.bind).toHaveBeenCalledWith(...bindings);

      statement.run.mockResolvedValue({ meta: { changes: 0 } });
      await expect(run()).resolves.toBe(false);
    },
  );

  it.each([null, 1_700_000_060_000])(
    "ends a live only in the observed grace state %s",
    async (graceExpiresAt) => {
      const { database, prepare, statement } = createDatabase();
      statement.first.mockResolvedValue({
        notification_message_id: "1300000000000000123",
      });

      await expect(
        endLive(database, {
          graceExpiresAt,
          sessionId: "session-1",
          userId: "user-1",
        }),
      ).resolves.toEqual({ notificationMessageId: 1_300_000_000_000_000_123n });
      expect(prepare).toHaveBeenCalledWith(
        "DELETE FROM lives WHERE user_id = ? AND session_id = ? AND grace_expires_at IS ? RETURNING notification_message_id",
      );
      expect(statement.bind).toHaveBeenCalledWith(
        "user-1",
        "session-1",
        graceExpiresAt,
      );
    },
  );

  it("reports when ending a live matched no row, or returned a bad row", async () => {
    const { database, statement } = createDatabase();
    const observed = {
      graceExpiresAt: null,
      sessionId: "session-1",
      userId: "user-1",
    };

    statement.first.mockResolvedValue(null);
    await expect(endLive(database, observed)).resolves.toBeNull();

    statement.first.mockResolvedValue({ notification_message_id: null });
    await expect(endLive(database, observed)).resolves.toEqual({
      notificationMessageId: null,
    });

    statement.first.mockResolvedValue({ notification_message_id: 45 });
    await expect(endLive(database, observed)).rejects.toThrow(
      "Invalid D1 ended lives row",
    );
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

  it("lists lives that are live or still within their grace period", async () => {
    const { database, prepare, statement } = createDatabase();
    statement.all.mockResolvedValue({
      results: [{ user_id: "user-1", display_name: "Streamer" }],
    });
    await expect(getAllLives(database, 1_700_000_000_000)).resolves.toEqual([
      { owner: { userId: "user-1", displayName: "Streamer" } },
    ]);
    expect(prepare).toHaveBeenCalledWith(
      "SELECT users.user_id, display_name FROM lives JOIN users ON lives.user_id = users.user_id WHERE lives.grace_expires_at IS NULL OR lives.grace_expires_at > ?",
    );
    expect(statement.bind).toHaveBeenCalledWith(1_700_000_000_000);

    statement.all.mockResolvedValue({ results: [{ user_id: "user-1" }] });
    await expect(getAllLives(database, 1_700_000_000_000)).rejects.toThrow(
      "Invalid D1 live list row",
    );
  });
});
