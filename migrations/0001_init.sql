CREATE TABLE IF NOT EXISTS live_tracks (
    user_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tracks_json TEXT NOT NULL,
    last_session_check DATETIME DEFAULT NULL
);

CREATE TABLE IF NOT EXISTS live_tokens (
    user_id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL
);
