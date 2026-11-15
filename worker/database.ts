// LiveState Durable Object のストレージ用 SQL。ここにある関数はすべて
// オブジェクト内で同期的に実行され、ルートからは ./live-state の RPC メソッド経由で参照する。
import type { StoredTrack } from "./sfu";
import * as v from "valibot";

export type User = {
  userId: string;
  displayName: string;
};

type Live = {
  owner: User;
};

/** 配信者ごとに 1 つ存在する配信（`lives` の 1 行）。 */
export type LiveRecord = {
  /** OBS の再接続をまたいで変わらない配信 ID。 */
  broadcastId: string;
  /** 再接続猶予期間の終了時刻（Unix エポックミリ秒）。インジェストセッションが配信中なら null。 */
  graceExpiresAt: number | null;
  /**
   * リクエストが SFU 上でインジェストセッションの生存を最後に確認した時刻
   * （Unix エポックミリ秒）。このセッションでまだ確認がなければ null。
   */
  sessionSeenActiveAt: number | null;
  userId: string;
  /** 現在の SFU インジェストセッション。再接続のたびに置き換わる。 */
  sessionId: string;
  /** `sessionId` のトラック。再接続のたびに置き換わる。 */
  tracks: StoredTrack[];
};

/** 行が削除された直後の配信。 */
export type EndedLive = {
  /** 開始通知の Discord snowflake（10 進数文字列）。 */
  notificationMessageId: string | null;
  sessionId: string;
  userId: string;
};

/**
 * 各エントリは 1 つのスキーマバージョンを表す。オブジェクトは起動時に未適用のエントリを
 * 順に適用するため、デプロイ済みのエントリは編集せず、変更は末尾に新しいエントリとして追加する。
 *
 * lives の列は LiveRecord と EndedLive の各フィールドに対応する（tracks_json は
 * StoredTrack[] の JSON）。live_tokens.token_hash は生トークンではなく HMAC。
 * 状態遷移は docs/architecture.md の「配信行のセマンティクス」を参照。
 */
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
  ],
];

// 以下の値は、書き込み時にも読み取りと同じスキーマで検証して保存前に拒否する。読み戻せない値が
// 1 つでも保存されると、通知 ID と時刻なら期限切れの配信の終了や次のアラームの計算を行う
// すべてのメソッドが、トラックならその配信者の getLive が以降ずっと失敗するため。

/** 10 進数文字列として表現された Discord snowflake。 */
function createNotificationMessageIdSchema() {
  return v.pipe(v.string(), v.regex(/^[0-9]+$/u));
}

let notificationMessageIdSchema:
  ReturnType<typeof createNotificationMessageIdSchema> | undefined;

function getNotificationMessageIdSchema() {
  notificationMessageIdSchema ??= createNotificationMessageIdSchema();

  return notificationMessageIdSchema;
}

/** Unix エポックミリ秒。 */
function createTimestampSchema() {
  return v.pipe(v.number(), v.integer());
}

let timestampSchema: ReturnType<typeof createTimestampSchema> | undefined;

function getTimestampSchema() {
  timestampSchema ??= createTimestampSchema();

  return timestampSchema;
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

/** @throws {Error} `value` が 10 進数文字列の Discord snowflake でない場合。 */
function assertNotificationMessageId(value: string, column: string): void {
  if (!v.is(getNotificationMessageIdSchema(), value)) {
    throw new Error(`Invalid ${column}`);
  }
}

/** @throws {Error} `value` が整数でない場合。 */
function assertTimestamp(value: number, column: string): void {
  if (!v.is(getTimestampSchema(), value)) {
    throw new Error(`Invalid ${column}`);
  }
}

/** @throws {Error} `tracks` が getLive で読み戻せない形式の場合。 */
function assertStoredTracks(tracks: StoredTrack[]): void {
  if (!v.is(getStoredTracksSchema(), tracks)) {
    throw new Error("Invalid lives.tracks_json");
  }
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
    grace_expires_at: v.nullable(getTimestampSchema()),
    session_seen_active_at: v.nullable(getTimestampSchema()),
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
    notification_message_id: v.nullable(getNotificationMessageIdSchema()),
    session_id: v.string(),
    user_id: v.string(),
  });
}

let endedLiveRowSchema: ReturnType<typeof createEndedLiveRowSchema> | undefined;

function getEndedLiveRowSchema() {
  endedLiveRowSchema ??= createEndedLiveRowSchema();

  return endedLiveRowSchema;
}

function createNextWakeRowSchema() {
  return v.object({
    wake_at: v.nullable(getTimestampSchema()),
  });
}

let nextWakeRowSchema: ReturnType<typeof createNextWakeRowSchema> | undefined;

function getNextWakeRowSchema() {
  nextWakeRowSchema ??= createNextWakeRowSchema();

  return nextWakeRowSchema;
}

/** @throws {Error} 行の形式が本モジュールの書き込む形式と一致しない場合。 */
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

/**
 * このストレージにまだ適用されていないすべてのスキーマバージョンのテーブルを作成する。
 *
 * @throws {Error} 記録済みのスキーマバージョンを読み取れなかった場合。
 */
export function migrateSchema(sql: SqlStorage): void {
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
 * 新しい配信を開始してその ID を返す。競合する別のインジェストが先に作成または
 * 再開したなどの理由で配信者（owner）がすでに live 行を持っている場合は null を返す。
 *
 * @throws {Error} `tracks` が getLive で読み戻せない形式の場合。この場合、何も保存されない。
 */
export function insertLive(
  sql: SqlStorage,
  userId: string,
  sessionId: string,
  tracks: StoredTrack[],
): string | null {
  assertStoredTracks(tracks);
  const broadcastId = crypto.randomUUID();
  // ここでは upsert を行わない。競合する 2 つ目のインジェストは既存の live 行を
  // 後続セッションで上書きして再通知するのではなく、フェイルクローズで拒否すべきである。
  // 再接続時は resumeLive で行を再開し、古い行は挿入前に終了される。
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

/**
 * @throws {Error} 保存されている行またはトラックの形式が本モジュールの書き込む形式と一致しない場合。
 */
export function getLive(sql: SqlStorage, userId: string): LiveRecord | null {
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
 * 開始通知のメッセージ ID を `broadcastId` の配信に保存する。該当する配信がすでに存在しない
 * 場合は false を返す。
 *
 * @throws {Error} `notificationMessageId` が 10 進数文字列の Discord snowflake でない場合。
 * この場合、何も保存されない。
 */
export function setLiveNotificationMessageId(
  sql: SqlStorage,
  userId: string,
  broadcastId: string,
  notificationMessageId: string,
): boolean {
  assertNotificationMessageId(
    notificationMessageId,
    "lives.notification_message_id",
  );
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
 * リクエストが SFU 上で配信中インジェストセッションの生存を確認したことを記録する。
 * 健全な配信の同時視聴者全員が毎回行を書き込まないよう、`minIntervalMs` ごとに
 * 最大 1 回のみ記録する。記録した場合は true、間隔内の記録がすでにあるか行がその
 * セッションを保持していない場合は false を返す。
 *
 * @throws {Error} `now` が整数でない場合。この場合、何も保存されない。
 */
export function markLiveSessionSeenActive(
  sql: SqlStorage,
  userId: string,
  sessionId: string,
  now: number,
  minIntervalMs: number,
): boolean {
  assertTimestamp(now, "lives.session_seen_active_at");
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

/**
 * 配信中のインジェストセッションを再接続猶予期間へ移行する。
 *
 * @throws {Error} `graceExpiresAt` が整数でない場合。この場合、何も保存されない。
 */
export function startLiveReconnectGrace(
  sql: SqlStorage,
  userId: string,
  sessionId: string,
  graceExpiresAt: number,
): boolean {
  assertTimestamp(graceExpiresAt, "lives.grace_expires_at");
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
 * 猶予期間中、または前回のセッションが DELETE なしで失われた直後に、新しい
 * インジェストセッションで配信を継続する。直前の session_id の一致を条件とするため
 * Compare-And-Set となり、すでに配信終了したか別のインジェストが再開した後では失敗する。
 *
 * @throws {Error} `tracks` が getLive で読み戻せない形式の場合。この場合、何も保存されない。
 */
export function resumeLive(
  sql: SqlStorage,
  userId: string,
  previousSessionId: string,
  sessionId: string,
  tracks: StoredTrack[],
): boolean {
  assertStoredTracks(tracks);
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
 * インジェストセッションが非アクティブと判明した配信を終了させる。ただし、行がその
 * セッションを猶予期間外で保持し続けている場合に限るため、競合する再接続や猶予開始が
 * 上書きされることはない。何も削除されなかった場合は null を返す。
 *
 * @throws {Error} 削除された行の形式が本モジュールの書き込む形式と一致しない場合。
 * この時点ですでに行は削除されているため、呼び出し側でロールバックする必要がある。
 */
export function endLive(
  sql: SqlStorage,
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

/**
 * 再接続猶予期間を過ぎたすべての配信を終了させる。
 *
 * @throws {Error} 削除された行の形式が本モジュールの書き込む形式と一致しない場合。
 * この時点ですでに行は削除されているため、呼び出し側でロールバックする必要がある。
 */
export function endOverdueLives(sql: SqlStorage, now: number): EndedLive[] {
  return sql
    .exec(
      "DELETE FROM lives WHERE grace_expires_at <= ? RETURNING user_id, session_id, notification_message_id",
      now,
    )
    .toArray()
    .map((row) => parseEndedLiveRow(row));
}

/**
 * 最も早く終わる再接続猶予期間の期限を返す。猶予期間中の配信がなければ null を返す。
 *
 * @throws {Error} 保存されている時刻値が整数にならない場合。
 */
export function getNextWakeAt(sql: SqlStorage): number | null {
  const rowResult = v.safeParse(
    getNextWakeRowSchema(),
    sql.exec("SELECT MIN(grace_expires_at) AS wake_at FROM lives").toArray()[0],
  );
  if (!rowResult.success) {
    throw new Error("Invalid next wake row");
  }

  return rowResult.output.wake_at;
}

export function setLiveToken(
  sql: SqlStorage,
  userId: string,
  tokenHash: string,
): void {
  sql.exec(
    "INSERT OR REPLACE INTO live_tokens (user_id, token_hash) VALUES (?, ?)",
    userId,
    tokenHash,
  );
}

/**
 * @throws {Error} 保存されている行の形式が本モジュールの書き込む形式と一致しない場合。
 */
export function getLiveTokenHash(
  sql: SqlStorage,
  userId: string,
): string | null {
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

export function hasLiveToken(sql: SqlStorage, userId: string): boolean {
  return (
    sql
      .exec(
        "SELECT 1 AS found FROM live_tokens WHERE user_id = ? LIMIT 1",
        userId,
      )
      .toArray().length > 0
  );
}

export function setUser(sql: SqlStorage, user: User): void {
  sql.exec(
    "INSERT OR REPLACE INTO users (user_id, display_name) VALUES (?, ?)",
    user.userId,
    user.displayName,
  );
}

/**
 * 再接続猶予期間中のものも含め、すべての配信の配信者一覧を返す。
 *
 * @throws {Error} 保存されている行の形式が本モジュールの書き込む形式と一致しない場合。
 */
export function getAllLives(sql: SqlStorage): Live[] {
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
