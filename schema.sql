-- D1 schema snapshot.
-- One live row exists per owner and represents one broadcast; user_id is also
-- the live id. broadcast_id stays the same while OBS reconnects, whereas
-- session_id and tracks_json (the StoredTrack array) point at the current
-- Cloudflare Calls ingest session and are replaced on every reconnect.
-- grace_expires_at is NULL while that ingest session is live. After OBS sends
-- DELETE it holds the Unix epoch milliseconds until which a new ingest resumes
-- the same broadcast; once it passes, the broadcast has ended.
-- notification_message_id is a Discord snowflake stored as decimal text because
-- it does not fit in a JavaScript number.
CREATE TABLE IF NOT EXISTS lives (
    user_id TEXT PRIMARY KEY,
    broadcast_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tracks_json TEXT NOT NULL,
    notification_message_id TEXT,
    grace_expires_at INTEGER
);

-- Publisher tokens are stored as HMAC hashes, not raw bearer tokens. Each user
-- has one current token.
CREATE TABLE IF NOT EXISTS live_tokens (
    user_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL
)
