import * as v from "valibot";

/**
 * 各エントリは 1 つのスキーマバージョンを表す。オブジェクトは起動時に未適用のエントリを
 * 順に適用するため、デプロイ済みのエントリは編集せず、変更は末尾に新しいエントリとして追加する。
 *
 * lives の列は LiveRecord の各フィールドと開始通知のメッセージ ID に対応する（tracks_json は
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
