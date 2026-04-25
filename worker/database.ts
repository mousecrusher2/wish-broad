import type { StoredTrack } from "./sfu";
import * as v from "valibot";

type User = {
  userId: string;
  displayName: string;
};

type Live = {
  owner: User;
};

type LiveTrackRecord = {
  notificationMessageId?: bigint | null | undefined;
  userId: string;
  sessionId: string;
  tracks: StoredTrack[];
};

function createLiveTrackRowSchema() {
  return v.object({
    notification_message_id: v.optional(
      v.nullish(v.union([v.number(), v.bigint()])),
    ),
    user_id: v.string(),
    session_id: v.string(),
    tracks_json: v.string(),
  });
}

let liveTrackRowSchema: ReturnType<typeof createLiveTrackRowSchema> | undefined;

function getLiveTrackRowSchema() {
  if (liveTrackRowSchema === undefined) {
    liveTrackRowSchema = createLiveTrackRowSchema();
  }

  return liveTrackRowSchema;
}

function createStoredTrackSchema() {
  return v.object({
    location: v.literal("remote"),
    sessionId: v.string(),
    trackName: v.string(),
    mid: v.string(),
  });
}

let storedTrackSchema: ReturnType<typeof createStoredTrackSchema> | undefined;

function getStoredTrackSchema() {
  if (storedTrackSchema === undefined) {
    storedTrackSchema = createStoredTrackSchema();
  }

  return storedTrackSchema;
}

function createStoredTracksSchema() {
  return v.array(getStoredTrackSchema());
}

let storedTracksSchema: ReturnType<typeof createStoredTracksSchema> | undefined;

function getStoredTracksSchema() {
  if (storedTracksSchema === undefined) {
    storedTracksSchema = createStoredTracksSchema();
  }

  return storedTracksSchema;
}

function createLiveTokenRowSchema() {
  return v.object({
    token_hash: v.string(),
  });
}

let liveTokenRowSchema: ReturnType<typeof createLiveTokenRowSchema> | undefined;

function getLiveTokenRowSchema() {
  if (liveTokenRowSchema === undefined) {
    liveTokenRowSchema = createLiveTokenRowSchema();
  }

  return liveTokenRowSchema;
}

function createLiveListRowSchema() {
  return v.object({
    user_id: v.string(),
    display_name: v.string(),
  });
}

let liveListRowSchema: ReturnType<typeof createLiveListRowSchema> | undefined;

function getLiveListRowSchema() {
  if (liveListRowSchema === undefined) {
    liveListRowSchema = createLiveListRowSchema();
  }

  return liveListRowSchema;
}

export async function insertLive(
  database: D1Database,
  userId: string,
  sessionId: string,
  tracks: StoredTrack[],
): Promise<void> {
  const tracksJson = JSON.stringify(tracks);
  // Do not upsert here. A concurrent second ingest should fail closed instead of
  // replacing the existing live row with a later session. Reconnects are handled
  // by deleting or proving the old Calls session is stale before inserting.
  await database
    .prepare(
      "INSERT INTO lives (user_id, session_id, tracks_json) VALUES (?, ?, ?)",
    )
    .bind(userId, sessionId, tracksJson)
    .run();
}

export async function getLive(
  database: D1Database,
  userId: string,
): Promise<LiveTrackRecord | null> {
  const result = await database
    .prepare(
      "SELECT user_id, session_id, tracks_json, notification_message_id FROM lives WHERE user_id = ?",
    )
    .bind(userId)
    .first();

  if (!result) {
    return null;
  }

  const rowResult = v.safeParse(getLiveTrackRowSchema(), result);
  if (!rowResult.success) {
    throw new Error("Invalid D1 lives row");
  }
  const row = rowResult.output;

  const parsedTracksInput: unknown = JSON.parse(row.tracks_json);
  const tracksResult = v.safeParse(getStoredTracksSchema(), parsedTracksInput);
  if (!tracksResult.success) {
    throw new Error("Invalid D1 lives.tracks_json");
  }

  return {
    notificationMessageId:
      row.notification_message_id === null ||
      row.notification_message_id === undefined
        ? null
        : BigInt(row.notification_message_id),
    userId: row.user_id,
    sessionId: row.session_id,
    tracks: tracksResult.output,
  };
}

export async function setLiveNotificationMessageId(
  database: D1Database,
  userId: string,
  sessionId: string,
  notificationMessageId: bigint,
): Promise<boolean> {
  const result = await database
    .prepare(
      "UPDATE lives SET notification_message_id = ? WHERE user_id = ? AND session_id = ?",
    )
    .bind(notificationMessageId, userId, sessionId)
    .run();

  return result.meta.changes > 0;
}

export async function deleteLiveForSession(
  database: D1Database,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await database
    .prepare("DELETE FROM lives WHERE user_id = ? AND session_id = ?")
    .bind(userId, sessionId)
    .run();

  return result.meta.changes > 0;
}

export async function setLiveToken(
  database: D1Database,
  userId: string,
  tokenHash: string,
): Promise<void> {
  await database
    .prepare(
      "INSERT OR REPLACE INTO live_tokens (user_id, token_hash) VALUES (?, ?)",
    )
    .bind(userId, tokenHash)
    .run();
}

export async function getLiveTokenHash(
  database: D1Database,
  userId: string,
): Promise<string | null> {
  const result = await database
    .prepare("SELECT token_hash FROM live_tokens WHERE user_id = ?")
    .bind(userId)
    .first();

  if (!result) {
    return null;
  }

  const rowResult = v.safeParse(getLiveTokenRowSchema(), result);
  if (!rowResult.success) {
    throw new Error("Invalid D1 live_tokens row");
  }

  return rowResult.output.token_hash;
}

export async function hasLiveToken(
  database: D1Database,
  userId: string,
): Promise<boolean> {
  const result = await database
    .prepare("SELECT 1 FROM live_tokens WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first();

  return !!result;
}

export async function setUser(database: D1Database, user: User): Promise<void> {
  await database
    .prepare(
      "INSERT OR REPLACE INTO users (user_id, display_name) VALUES (?, ?)",
    )
    .bind(user.userId, user.displayName)
    .run();
}

export async function getAllLives(database: D1Database): Promise<Live[]> {
  // This intentionally does not verify every Calls session. Listing must stay
  // cheap; stale rows are reconciled on user-specific ingest/play requests.
  const results = await database
    .prepare(
      "SELECT users.user_id, display_name FROM lives JOIN users ON lives.user_id = users.user_id",
    )
    .all();

  return results.results.map((row) => {
    const rowResult = v.safeParse(getLiveListRowSchema(), row);
    if (!rowResult.success) {
      throw new Error("Invalid D1 live list row");
    }
    const parsedRow = rowResult.output;

    return {
      owner: {
        userId: parsedRow.user_id,
        displayName: parsedRow.display_name,
      },
    };
  });
}
