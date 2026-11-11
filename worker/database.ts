import type { StoredTrack } from "./sfu";
import * as v from "valibot";

type User = {
  userId: string;
  displayName: string;
};

type Live = {
  owner: User;
};

export type LiveRecord = {
  broadcastId: string;
  // null while the ingest session is live; otherwise the end of the reconnect
  // grace period in Unix epoch milliseconds.
  graceExpiresAt: number | null;
  notificationMessageId: bigint | null;
  userId: string;
  sessionId: string;
  tracks: StoredTrack[];
};

// The exact live row state a caller observed, used for compare-and-delete.
type ObservedLive = Pick<LiveRecord, "graceExpiresAt" | "sessionId" | "userId">;

function createNotificationMessageIdSchema() {
  return v.nullable(v.pipe(v.string(), v.regex(/^[0-9]+$/u)));
}

function createLiveTrackRowSchema() {
  return v.object({
    broadcast_id: v.string(),
    grace_expires_at: v.nullable(v.pipe(v.number(), v.integer())),
    notification_message_id: createNotificationMessageIdSchema(),
    user_id: v.string(),
    session_id: v.string(),
    tracks_json: v.string(),
  });
}

let liveTrackRowSchema: ReturnType<typeof createLiveTrackRowSchema> | undefined;

function getLiveTrackRowSchema() {
  liveTrackRowSchema ??= createLiveTrackRowSchema();

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
  storedTrackSchema ??= createStoredTrackSchema();

  return storedTrackSchema;
}

function createStoredTracksSchema() {
  return v.array(getStoredTrackSchema());
}

let storedTracksSchema: ReturnType<typeof createStoredTracksSchema> | undefined;

function getStoredTracksSchema() {
  storedTracksSchema ??= createStoredTracksSchema();

  return storedTracksSchema;
}

function createLiveTokenRowSchema() {
  return v.object({
    token_hash: v.string(),
  });
}

let liveTokenRowSchema: ReturnType<typeof createLiveTokenRowSchema> | undefined;

function getLiveTokenRowSchema() {
  liveTokenRowSchema ??= createLiveTokenRowSchema();

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
  liveListRowSchema ??= createLiveListRowSchema();

  return liveListRowSchema;
}

function createEndedLiveRowSchema() {
  return v.object({
    notification_message_id: createNotificationMessageIdSchema(),
  });
}

let endedLiveRowSchema: ReturnType<typeof createEndedLiveRowSchema> | undefined;

function getEndedLiveRowSchema() {
  endedLiveRowSchema ??= createEndedLiveRowSchema();

  return endedLiveRowSchema;
}

function parseNotificationMessageId(value: string | null): bigint | null {
  return value === null ? null : BigInt(value);
}

/** Starts a new broadcast and returns its id. */
export async function insertLive(
  database: D1Database,
  userId: string,
  sessionId: string,
  tracks: StoredTrack[],
): Promise<string> {
  const broadcastId = crypto.randomUUID();
  const tracksJson = JSON.stringify(tracks);
  // Do not upsert here. A concurrent second ingest should fail closed instead of
  // replacing the existing live row with a later session. Reconnects resume the
  // row through resumeLive, and stale rows are ended before inserting.
  await database
    .prepare(
      "INSERT INTO lives (user_id, broadcast_id, session_id, tracks_json) VALUES (?, ?, ?, ?)",
    )
    .bind(userId, broadcastId, sessionId, tracksJson)
    .run();

  return broadcastId;
}

export async function getLive(
  database: D1Database,
  userId: string,
): Promise<LiveRecord | null> {
  const result = await database
    .prepare(
      "SELECT user_id, broadcast_id, session_id, tracks_json, notification_message_id, grace_expires_at FROM lives WHERE user_id = ?",
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
    broadcastId: row.broadcast_id,
    graceExpiresAt: row.grace_expires_at,
    notificationMessageId: parseNotificationMessageId(
      row.notification_message_id,
    ),
    userId: row.user_id,
    sessionId: row.session_id,
    tracks: tracksResult.output,
  };
}

/**
 * Stores the start notification on the broadcast, not the ingest session, so
 * it survives a reconnect that happens while the notification is being sent.
 */
export async function setLiveNotificationMessageId(
  database: D1Database,
  userId: string,
  broadcastId: string,
  notificationMessageId: bigint,
): Promise<boolean> {
  // D1 cannot bind bigint values; the column stores the snowflake as text.
  const result = await database
    .prepare(
      "UPDATE lives SET notification_message_id = ? WHERE user_id = ? AND broadcast_id = ?",
    )
    .bind(notificationMessageId.toString(), userId, broadcastId)
    .run();

  return result.meta.changes > 0;
}

/** Moves a live ingest session into its reconnect grace period. */
export async function startLiveReconnectGrace(
  database: D1Database,
  userId: string,
  sessionId: string,
  graceExpiresAt: number,
): Promise<boolean> {
  const result = await database
    .prepare(
      "UPDATE lives SET grace_expires_at = ? WHERE user_id = ? AND session_id = ? AND grace_expires_at IS NULL",
    )
    .bind(graceExpiresAt, userId, sessionId)
    .run();

  return result.meta.changes > 0;
}

/**
 * Continues a broadcast in its grace period with a new ingest session. Changing
 * session_id also turns the pending end of the previous grace period into a
 * no-op, because endLive only matches the exact state it observed.
 */
export async function resumeLive(
  database: D1Database,
  userId: string,
  previousSessionId: string,
  sessionId: string,
  tracks: StoredTrack[],
): Promise<boolean> {
  const result = await database
    .prepare(
      "UPDATE lives SET session_id = ?, tracks_json = ?, grace_expires_at = NULL WHERE user_id = ? AND session_id = ? AND grace_expires_at IS NOT NULL",
    )
    .bind(sessionId, JSON.stringify(tracks), userId, previousSessionId)
    .run();

  return result.meta.changes > 0;
}

/**
 * Ends a broadcast only if its row still has the observed session and grace
 * state, so a concurrent reconnect or grace start is never overwritten.
 * Returns null when nothing was deleted.
 */
export async function endLive(
  database: D1Database,
  live: ObservedLive,
): Promise<{ notificationMessageId: bigint | null } | null> {
  // `IS ?` matches NULL as well as a concrete grace deadline.
  const result = await database
    .prepare(
      "DELETE FROM lives WHERE user_id = ? AND session_id = ? AND grace_expires_at IS ? RETURNING notification_message_id",
    )
    .bind(live.userId, live.sessionId, live.graceExpiresAt)
    .first();

  if (!result) {
    return null;
  }

  const rowResult = v.safeParse(getEndedLiveRowSchema(), result);
  if (!rowResult.success) {
    throw new Error("Invalid D1 ended lives row");
  }

  return {
    notificationMessageId: parseNotificationMessageId(
      rowResult.output.notification_message_id,
    ),
  };
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

export async function getAllLives(
  database: D1Database,
  now: number,
): Promise<Live[]> {
  // This intentionally does not verify every Calls session. Listing must stay
  // cheap; stale rows are reconciled on user-specific ingest/play requests.
  // Broadcasts waiting for OBS to reconnect stay listed until their grace
  // period passes, even if the scheduled cleanup has not removed them yet.
  const results = await database
    .prepare(
      "SELECT users.user_id, display_name FROM lives JOIN users ON lives.user_id = users.user_id WHERE lives.grace_expires_at IS NULL OR lives.grace_expires_at > ?",
    )
    .bind(now)
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
