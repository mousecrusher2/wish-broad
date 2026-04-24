-- D1 schema snapshot.
-- One live row exists per owner. user_id is also the live id, and tracks_json is
-- the StoredTrack array for the exact Cloudflare Calls ingest session.
CREATE TABLE IF NOT EXISTS lives (
    user_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tracks_json TEXT NOT NULL,
    notification_message_id INTEGER
);

-- Publisher tokens are stored as HMAC hashes, not raw bearer tokens. Each user
-- has one current token.
CREATE TABLE IF NOT EXISTS live_tokens (
    user_id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL
)
