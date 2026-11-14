// LiveState Durable Object のストレージ用 SQL。ここにある関数はすべて
// オブジェクト内で同期的に実行され、ルートからは ./live-state の RPC メソッド経由で参照する。
import type { StoredTrack } from "./sfu";
import * as v from "valibot";

type SqlValue = string | number | null;

/**
 * これらのクエリが利用する Durable Object の SQL API の一部。
 * テストも同じインターフェースを通じて Node の SQLite 上で同じクエリを実行する。
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
  // インジェストセッションが配信中の場合は null、それ以外は再接続猶予期間の
  // 終了時刻（Unix エポックミリ秒）。
  graceExpiresAt: number | null;
  // リクエストが Calls 上でインジェストセッションの生存を最後に確認した時刻
  // （Unix エポックミリ秒）。セッション保存後に確認がまだない場合は null。
  sessionSeenActiveAt: number | null;
  userId: string;
  sessionId: string;
  tracks: StoredTrack[];
};

/** 行が削除された直後の配信。 */
export type EndedLive = {
  // 開始通知メッセージの Discord snowflake（10 進数文字列）。
  notificationMessageId: string | null;
  sessionId: string;
  userId: string;
};

/** まだ Discord から削除されていない開始通知。 */
export type NotificationDelete = {
  // これまでに削除タスクが払い出された回数。
  attempts: number;
  messageId: string;
  userId: string;
};

// 各エントリは 1 つのスキーマバージョンを表す。オブジェクトは起動時に未適用バージョンを
// 順次適用するため、デプロイ済みエントリは編集せず新しいエントリを末尾に追記すること。
//
// 配信者（owner）ごとに 1 行の live 行が存在して 1 つの配信を表し、user_id がそのまま
// live id になる。OBS の再接続中も broadcast_id は変わらない一方、session_id と
// tracks_json（StoredTrack の配列）は現在の Cloudflare Calls インジェストセッションを
// 指しており、再接続のたびに置き換わる。
// grace_expires_at はインジェストセッションの配信中は NULL となり、OBS が DELETE を
// 送信した後は、新しいインジェストが同じ配信を再開できる期限（Unix エポックミリ秒）を保持する。
// その期限を過ぎると配信は終了する。
// notification_message_id は JavaScript の数値型に収まらない Discord snowflake を
// 10 進数文字列として保存したもの。
// session_seen_active_at はリクエストが Calls 上でインジェストセッションの生存を
// 最後に確認した時刻（Unix エポックミリ秒、最大 10 秒ごとに記録）、または NULL。
// OBS が DELETE を送らずに Calls によってガベージコレクションされたセッションが直前に
// 失われたものかを判別し、OBS が配信を再開できるようにするために用いる。
//
// 配信者トークンは生の Bearer トークンではなく HMAC ハッシュとして保存する。各ユーザーは
// 最新のトークンを 1 つ持つ。
//
// notification_deletes は Discord から削除すべき開始通知のアウトボックスである。
// attempts は削除タスクを Worker に払い出した回数、next_attempt_at は次に払い出し
// （再払い出し）が可能になる時刻（Unix エポックミリ秒）を表す。
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

// オブジェクトの全メソッドは期限切れの配信を終了させて次のアラームを計算し、
// いずれの処理も以下の 2 種類の値を読み取る。読み戻せない値が保存されると後続の
// すべての呼び出しが失敗するため、書き込み時に読み取り用スキーマで検証し、不正な値を
// 保存前に拒否する。

// 10 進数文字列として表現された Discord snowflake。
function createNotificationMessageIdSchema() {
  return v.pipe(v.string(), v.regex(/^[0-9]+$/u));
}

let notificationMessageIdSchema:
  ReturnType<typeof createNotificationMessageIdSchema> | undefined;

function getNotificationMessageIdSchema() {
  notificationMessageIdSchema ??= createNotificationMessageIdSchema();

  return notificationMessageIdSchema;
}

// Unix エポックミリ秒。
function createTimestampSchema() {
  return v.pipe(v.number(), v.integer());
}

let timestampSchema: ReturnType<typeof createTimestampSchema> | undefined;

function getTimestampSchema() {
  timestampSchema ??= createTimestampSchema();

  return timestampSchema;
}

function assertNotificationMessageId(value: string, column: string): void {
  if (!v.is(getNotificationMessageIdSchema(), value)) {
    throw new Error(`Invalid ${column}`);
  }
}

function assertTimestamp(value: number, column: string): void {
  if (!v.is(getTimestampSchema(), value)) {
    throw new Error(`Invalid ${column}`);
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
    wake_at: v.nullable(getTimestampSchema()),
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

/**
 * このストレージにまだ適用されていないすべてのスキーマバージョンのテーブルを作成する。
 *
 * @throws {Error} 記録済みのスキーマバージョンを読み取れなかった場合。
 */
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
 * 新しい配信を開始してその ID を返す。競合する別のインジェストが先に作成または
 * 再開したなどの理由で配信者（owner）がすでに live 行を持っている場合は null を返す。
 */
export function insertLive(
  sql: Sql,
  userId: string,
  sessionId: string,
  tracks: StoredTrack[],
): string | null {
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
 * 開始通知をインジェストセッションではなく配信本体に保存することで、通知送信中に
 * 再接続が発生しても情報が引き継がれるようにする。該当する配信がすでに存在しない場合は
 * false を返す。
 *
 * @throws {Error} `notificationMessageId` が 10 進数文字列の Discord snowflake でない場合。
 * この場合、何も保存されない。
 */
export function setLiveNotificationMessageId(
  sql: Sql,
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
 * リクエストが Calls 上で配信中インジェストセッションの生存を確認したことを記録する。
 * 健全な配信の同時視聴者全員が毎回行を書き込まないよう、`minIntervalMs` ごとに
 * 最大 1 回のみ記録する。
 *
 * @throws {Error} `now` が整数でない場合。この場合、何も保存されない。
 */
export function markLiveSessionSeenActive(
  sql: Sql,
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
  sql: Sql,
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
 * インジェストセッションが非アクティブと判明した配信を終了させる。ただし、行がその
 * セッションを猶予期間外で保持し続けている場合に限るため、競合する再接続や猶予開始が
 * 上書きされることはない。何も削除されなかった場合は null を返す。
 *
 * @throws {Error} 削除された行の形式が本モジュールの書き込む形式と一致しない場合。
 * この時点ですでに行は削除されているため、呼び出し側でロールバックする必要がある。
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

/**
 * 再接続猶予期間を過ぎたすべての配信を終了させる。
 *
 * @throws {Error} 削除された行の形式が本モジュールの書き込む形式と一致しない場合。
 * この時点ですでに行は削除されているため、呼び出し側でロールバックする必要がある。
 */
export function endOverdueLives(sql: Sql, now: number): EndedLive[] {
  return sql
    .exec(
      "DELETE FROM lives WHERE grace_expires_at <= ? RETURNING user_id, session_id, notification_message_id",
      now,
    )
    .toArray()
    .map((row) => parseEndedLiveRow(row));
}

/**
 * `nextAttemptAt` 以降に削除を実行するよう開始通知をキューに追加する。
 * すでにキューに入っている通知については試行回数と次回予定時刻を維持する。
 *
 * @throws {Error} `messageId` が 10 進数文字列の Discord snowflake でない場合、または
 * `nextAttemptAt` が整数でない場合。この場合、何も保存されない。
 */
export function enqueueNotificationDelete(
  sql: Sql,
  messageId: string,
  userId: string,
  nextAttemptAt: number,
): void {
  assertNotificationMessageId(messageId, "notification_deletes.message_id");
  assertTimestamp(nextAttemptAt, "notification_deletes.next_attempt_at");
  sql.exec(
    "INSERT INTO notification_deletes (message_id, user_id, attempts, next_attempt_at) VALUES (?, ?, 0, ?) ON CONFLICT (message_id) DO NOTHING",
    messageId,
    userId,
    nextAttemptAt,
  );
}

/**
 * 時刻 `now` 時点で払い出し可能な通知削除タスクを古い順に返す。
 *
 * @throws {Error} 保存されている行の形式が本モジュールの書き込む形式と一致しない場合。
 */
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

/**
 * 試行回数を 1 増やし、`nextAttemptAt` までその削除タスクを非表示にする。
 *
 * @throws {Error} `nextAttemptAt` が整数でない場合。この場合、何も保存されない。
 */
export function leaseNotificationDelete(
  sql: Sql,
  messageId: string,
  nextAttemptAt: number,
): void {
  assertTimestamp(nextAttemptAt, "notification_deletes.next_attempt_at");
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
 * 保存済みの状態に対して処理が必要になる最も早い時刻（猶予期間の終了または
 * 通知削除の実行期限到来）を返す。保留中の処理がなければ null を返す。
 *
 * @throws {Error} 保存されている時刻値が整数にならない場合。
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

/**
 * @throws {Error} 保存されている行の形式が本モジュールの書き込む形式と一致しない場合。
 */
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

/**
 * OBS の再接続待ち中のものも含め、すべての配信の配信者一覧を返す。
 *
 * @throws {Error} 保存されている行の形式が本モジュールの書き込む形式と一致しない場合。
 */
export function getAllLives(sql: Sql): Live[] {
  // ここでは意図的に全 Calls セッションの生存確認を行わない。一覧取得は軽量に保ち、
  // 古い行の整合はユーザー指定のインジェスト/再生リクエスト時に行う。
  // OBS の再接続待ち中の配信は、猶予期間が経過するまで一覧に残る。
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
