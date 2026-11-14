// SQL for the LiveState Durable Object's storage. Every function here runs
// synchronously inside that object; routes reach this data through its RPC
// methods in ./live-state.
import type { StoredTrack } from "./sfu";
import * as v from "valibot";

type SqlValue = string | number | null;

/**
 * The part of a Durable Object's SQL API these queries use. Tests run the same
 * queries against Node's SQLite through this shape.
 */
export type Sql = {
  exec(
    query: string,
    ...bindings: SqlValue[]
  ): { toArray(): Record<string, unknown>[] };
};

export type User = {
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
  // When a request last found the ingest session active in Calls, in Unix
  // epoch milliseconds, or null if none has since the session was stored.
  sessionSeenActiveAt: number | null;
  userId: string;
  sessionId: string;
  tracks: StoredTrack[];
};

/** A broadcast whose row was just removed. */
export type EndedLive = {
  // The Discord snowflake of its start notification as decimal text.
  notificationMessageId: string | null;
  sessionId: string;
  userId: string;
};

/** A start notification that still has to be deleted from Discord. */
export type NotificationDelete = {
  // How many times the delete has been handed out so far.
  attempts: number;
  messageId: string;
  userId: string;
};

// Each entry is one schema version. An object applies the versions it has not
// recorded yet when it starts, so append a new entry instead of editing one
// that has been deployed.
//
// One live row exists per owner and represents one broadcast; user_id is also
// the live id. broadcast_id stays the same while OBS reconnects, whereas
// session_id and tracks_json (the StoredTrack array) point at the current
// Cloudflare Calls ingest session and are replaced on every reconnect.
// grace_expires_at is NULL while that ingest session is live. After OBS sends
// DELETE it holds the Unix epoch milliseconds until which a new ingest resumes
// the same broadcast; once it passes, the broadcast has ended.
// notification_message_id is a Discord snowflake stored as decimal text because
// it does not fit in a JavaScript number.
// session_seen_active_at is the Unix epoch milliseconds when a request last
// found the ingest session active in Calls (written at most every 10 seconds),
// or NULL. It tells whether a session that Calls garbage-collected without OBS
// sending DELETE was lost just now, so OBS can still resume the broadcast.
//
// Publisher tokens are stored as HMAC hashes, not raw bearer tokens. Each user
// has one current token.
//
// notification_deletes is the outbox of start notifications to delete from
// Discord. attempts counts how often a delete was handed to the Worker, and
// next_attempt_at is the Unix epoch milliseconds from which it may be handed
// out (again).
const SCHEMA_MIGRATIONS: readonly (readonly string[])[] = [
  [
    `CREATE TABLE lives (
      user_id TEXT PRIMARY KEY,
      broadcast_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tracks_json TEXT NOT NULL,
      notification_message_id TEXT,
      grace_expires_at INTEGER,
      session_seen_active_at INTEGER
    )`,
    `CREATE TABLE live_tokens (
      user_id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE
    )`,
    `CREATE TABLE users (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL
    )`,
    `CREATE TABLE notification_deletes (
      message_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_attempt_at INTEGER NOT NULL
    )`,
  ],
];

function createNotificationMessageIdSchema() {
  return v.nullable(v.pipe(v.string(), v.regex(/^[0-9]+$/u)));
}

function createSchemaVersionRowSchema() {
  return v.object({
    version: v.pipe(v.number(), v.integer()),
  });
}

let schemaVersionRowSchema:
  ReturnType<typeof createSchemaVersionRowSchema> | undefined;

function getSchemaVersionRowSchema() {
  schemaVersionRowSchema ??= createSchemaVersionRowSchema();

  return schemaVersionRowSchema;
}

function createLiveRowSchema() {
  return v.object({
    broadcast_id: v.string(),
    grace_expires_at: v.nullable(v.pipe(v.number(), v.integer())),
    session_seen_active_at: v.nullable(v.pipe(v.number(), v.integer())),
    user_id: v.string(),
    session_id: v.string(),
    tracks_json: v.string(),
  });
}

let liveRowSchema: ReturnType<typeof createLiveRowSchema> | undefined;

function getLiveRowSchema() {
  liveRowSchema ??= createLiveRowSchema();

  return liveRowSchema;
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
    session_id: v.string(),
    user_id: v.string(),
  });
}

let endedLiveRowSchema: ReturnType<typeof createEndedLiveRowSchema> | undefined;

function getEndedLiveRowSchema() {
  endedLiveRowSchema ??= createEndedLiveRowSchema();

  return endedLiveRowSchema;
}

function createNotificationDeleteRowSchema() {
  return v.object({
    attempts: v.pipe(v.number(), v.integer()),
    message_id: v.string(),
    user_id: v.string(),
  });
}

let notificationDeleteRowSchema:
  ReturnType<typeof createNotificationDeleteRowSchema> | undefined;

function getNotificationDeleteRowSchema() {
  notificationDeleteRowSchema ??= createNotificationDeleteRowSchema();

  return notificationDeleteRowSchema;
}

function createNextWakeRowSchema() {
  return v.object({
    wake_at: v.nullable(v.pipe(v.number(), v.integer())),
  });
}

let nextWakeRowSchema: ReturnType<typeof createNextWakeRowSchema> | undefined;

function getNextWakeRowSchema() {
  nextWakeRowSchema ??= createNextWakeRowSchema();

  return nextWakeRowSchema;
}

function parseEndedLiveRow(row: unknown): EndedLive {
  const rowResult = v.safeParse(getEndedLiveRowSchema(), row);
  if (!rowResult.success) {
    throw new Error("Invalid ended lives row");
  }

  return {
    notificationMessageId: rowResult.output.notification_message_id,
    sessionId: rowResult.output.session_id,
    userId: rowResult.output.user_id,
  };
}

/** Creates the tables of every schema version this storage does not have yet. */
export function migrateSchema(sql: Sql): void {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)",
  );
  const versionResult = v.safeParse(
    getSchemaVersionRowSchema(),
    sql
      .exec(
        "SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations",
      )
      .toArray()[0],
  );
  if (!versionResult.success) {
    throw new Error("Invalid schema_migrations row");
  }

  for (const [index, statements] of SCHEMA_MIGRATIONS.entries()) {
    const version = index + 1;
    if (version > versionResult.output.version) {
      for (const statement of statements) {
        sql.exec(statement);
      }
      sql.exec("INSERT INTO schema_migrations (version) VALUES (?)", version);
    }
  }
}

/**
 * Starts a new broadcast and returns its id, or null when the owner already
 * has a live row, for example because a concurrent ingest created or resumed
 * it first.
 */
export function insertLive(
  sql: Sql,
  userId: string,
  sessionId: string,
  tracks: StoredTrack[],
): string | null {
  const broadcastId = crypto.randomUUID();
  // Do not upsert here. A concurrent second ingest must fail closed instead of
  // replacing the existing live row with a later session and notifying again.
  // Reconnects resume the row through resumeLive, and stale rows are ended
  // before inserting.
  const inserted = sql
    .exec(
      "INSERT INTO lives (user_id, broadcast_id, session_id, tracks_json) VALUES (?, ?, ?, ?) ON CONFLICT (user_id) DO NOTHING RETURNING user_id",
      userId,
      broadcastId,
      sessionId,
      JSON.stringify(tracks),
    )
    .toArray();

  return inserted.length > 0 ? broadcastId : null;
}

export function getLive(sql: Sql, userId: string): LiveRecord | null {
  const [result] = sql
    .exec(
      "SELECT user_id, broadcast_id, session_id, tracks_json, grace_expires_at, session_seen_active_at FROM lives WHERE user_id = ?",
      userId,
    )
    .toArray();
  if (result === undefined) {
    return null;
  }

  const rowResult = v.safeParse(getLiveRowSchema(), result);
  if (!rowResult.success) {
    throw new Error("Invalid lives row");
  }
  const row = rowResult.output;

  const parsedTracksInput: unknown = JSON.parse(row.tracks_json);
  const tracksResult = v.safeParse(getStoredTracksSchema(), parsedTracksInput);
  if (!tracksResult.success) {
    throw new Error("Invalid lives.tracks_json");
  }

  return {
    broadcastId: row.broadcast_id,
    graceExpiresAt: row.grace_expires_at,
    sessionSeenActiveAt: row.session_seen_active_at,
    userId: row.user_id,
    sessionId: row.session_id,
    tracks: tracksResult.output,
  };
}

/**
 * Stores the start notification on the broadcast, not the ingest session, so
 * it survives a reconnect that happens while the notification is being sent.
 * Returns false when that broadcast no longer exists.
 */
export function setLiveNotificationMessageId(
  sql: Sql,
  userId: string,
  broadcastId: string,
  notificationMessageId: string,
): boolean {
  const updated = sql
    .exec(
      "UPDATE lives SET notification_message_id = ? WHERE user_id = ? AND broadcast_id = ? RETURNING user_id",
      notificationMessageId,
      userId,
      broadcastId,
    )
    .toArray();

  return updated.length > 0;
}

/**
 * Records that a request found the live ingest session still active in Calls,
 * at most once per `minIntervalMs`, so concurrent viewers of a healthy stream
 * do not each write a row.
 */
export function markLiveSessionSeenActive(
  sql: Sql,
  userId: string,
  sessionId: string,
  now: number,
  minIntervalMs: number,
): boolean {
  const updated = sql
    .exec(
      "UPDATE lives SET session_seen_active_at = ? WHERE user_id = ? AND session_id = ? AND (session_seen_active_at IS NULL OR session_seen_active_at <= ?) RETURNING user_id",
      now,
      userId,
      sessionId,
      now - minIntervalMs,
    )
    .toArray();

  return updated.length > 0;
}

/** Moves a live ingest session into its reconnect grace period. */
export function startLiveReconnectGrace(
  sql: Sql,
  userId: string,
  sessionId: string,
  graceExpiresAt: number,
): boolean {
  const updated = sql
    .exec(
      "UPDATE lives SET grace_expires_at = ? WHERE user_id = ? AND session_id = ? AND grace_expires_at IS NULL RETURNING user_id",
      graceExpiresAt,
      userId,
      sessionId,
    )
    .toArray();

  return updated.length > 0;
}

/**
 * Continues a broadcast with a new ingest session, either during its grace
 * period or right after its previous session was lost without DELETE. Matching
 * the previous session_id makes this a compare-and-swap: it fails once the
 * broadcast ended or another ingest resumed it.
 */
export function resumeLive(
  sql: Sql,
  userId: string,
  previousSessionId: string,
  sessionId: string,
  tracks: StoredTrack[],
): boolean {
  const updated = sql
    .exec(
      "UPDATE lives SET session_id = ?, tracks_json = ?, grace_expires_at = NULL, session_seen_active_at = NULL WHERE user_id = ? AND session_id = ? RETURNING user_id",
      sessionId,
      JSON.stringify(tracks),
      userId,
      previousSessionId,
    )
    .toArray();

  return updated.length > 0;
}

/**
 * Ends a broadcast whose ingest session was found inactive, but only while its
 * row still holds that session outside a grace period, so a concurrent
 * reconnect or grace start is never overwritten. Returns null when nothing was
 * deleted.
 */
export function endLive(
  sql: Sql,
  userId: string,
  sessionId: string,
): EndedLive | null {
  const [deleted] = sql
    .exec(
      "DELETE FROM lives WHERE user_id = ? AND session_id = ? AND grace_expires_at IS NULL RETURNING user_id, session_id, notification_message_id",
      userId,
      sessionId,
    )
    .toArray();

  return deleted === undefined ? null : parseEndedLiveRow(deleted);
}

/** Ends every broadcast whose reconnect grace period has passed. */
export function endOverdueLives(sql: Sql, now: number): EndedLive[] {
  return sql
    .exec(
      "DELETE FROM lives WHERE grace_expires_at <= ? RETURNING user_id, session_id, notification_message_id",
      now,
    )
    .toArray()
    .map((row) => parseEndedLiveRow(row));
}

/** Queues a start notification for deletion from `nextAttemptAt` on. */
export function enqueueNotificationDelete(
  sql: Sql,
  messageId: string,
  userId: string,
  nextAttemptAt: number,
): void {
  sql.exec(
    "INSERT INTO notification_deletes (message_id, user_id, attempts, next_attempt_at) VALUES (?, ?, 0, ?) ON CONFLICT (message_id) DO NOTHING",
    messageId,
    userId,
    nextAttemptAt,
  );
}

export function getDueNotificationDeletes(
  sql: Sql,
  now: number,
): NotificationDelete[] {
  return sql
    .exec(
      "SELECT message_id, user_id, attempts FROM notification_deletes WHERE next_attempt_at <= ? ORDER BY next_attempt_at, message_id",
      now,
    )
    .toArray()
    .map((row) => {
      const rowResult = v.safeParse(getNotificationDeleteRowSchema(), row);
      if (!rowResult.success) {
        throw new Error("Invalid notification_deletes row");
      }

      return {
        attempts: rowResult.output.attempts,
        messageId: rowResult.output.message_id,
        userId: rowResult.output.user_id,
      };
    });
}

/** Counts one more attempt and hides the delete until `nextAttemptAt`. */
export function leaseNotificationDelete(
  sql: Sql,
  messageId: string,
  nextAttemptAt: number,
): void {
  sql.exec(
    "UPDATE notification_deletes SET attempts = attempts + 1, next_attempt_at = ? WHERE message_id = ?",
    nextAttemptAt,
    messageId,
  );
}

export function removeNotificationDelete(sql: Sql, messageId: string): void {
  sql.exec("DELETE FROM notification_deletes WHERE message_id = ?", messageId);
}

/**
 * The earliest time at which stored state needs attention: a grace period
 * ending or a notification delete becoming due. Null when nothing is pending.
 */
export function getNextWakeAt(sql: Sql): number | null {
  const rowResult = v.safeParse(
    getNextWakeRowSchema(),
    sql
      .exec(
        "SELECT MIN(wake_at) AS wake_at FROM (SELECT grace_expires_at AS wake_at FROM lives WHERE grace_expires_at IS NOT NULL UNION ALL SELECT next_attempt_at AS wake_at FROM notification_deletes)",
      )
      .toArray()[0],
  );
  if (!rowResult.success) {
    throw new Error("Invalid next wake row");
  }

  return rowResult.output.wake_at;
}

export function setLiveToken(
  sql: Sql,
  userId: string,
  tokenHash: string,
): void {
  sql.exec(
    "INSERT OR REPLACE INTO live_tokens (user_id, token_hash) VALUES (?, ?)",
    userId,
    tokenHash,
  );
}

export function getLiveTokenHash(sql: Sql, userId: string): string | null {
  const [result] = sql
    .exec("SELECT token_hash FROM live_tokens WHERE user_id = ?", userId)
    .toArray();
  if (result === undefined) {
    return null;
  }

  const rowResult = v.safeParse(getLiveTokenRowSchema(), result);
  if (!rowResult.success) {
    throw new Error("Invalid live_tokens row");
  }

  return rowResult.output.token_hash;
}

export function hasLiveToken(sql: Sql, userId: string): boolean {
  return (
    sql
      .exec(
        "SELECT 1 AS found FROM live_tokens WHERE user_id = ? LIMIT 1",
        userId,
      )
      .toArray().length > 0
  );
}

export function setUser(sql: Sql, user: User): void {
  sql.exec(
    "INSERT OR REPLACE INTO users (user_id, display_name) VALUES (?, ?)",
    user.userId,
    user.displayName,
  );
}

export function getAllLives(sql: Sql): Live[] {
  // This intentionally does not verify every Calls session. Listing must stay
  // cheap; stale rows are reconciled on user-specific ingest/play requests.
  // Broadcasts waiting for OBS to reconnect stay listed until their grace
  // period passes.
  return sql
    .exec(
      "SELECT users.user_id, display_name FROM lives JOIN users ON lives.user_id = users.user_id ORDER BY users.user_id",
    )
    .toArray()
    .map((row) => {
      const rowResult = v.safeParse(getLiveListRowSchema(), row);
      if (!rowResult.success) {
        throw new Error("Invalid live list row");
      }

      return {
        owner: {
          userId: rowResult.output.user_id,
          displayName: rowResult.output.display_name,
        },
      };
    });
}
