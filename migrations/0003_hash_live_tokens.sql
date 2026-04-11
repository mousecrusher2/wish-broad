DROP TABLE IF EXISTS live_tokens;

CREATE TABLE live_tokens (
    user_id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE
);
