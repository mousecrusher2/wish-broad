-- D1データベースのスキーマ
-- useridにつき1行で、StoredTrack配列のJSONを保存する
-- useridはlive_idと同一
CREATE TABLE IF NOT EXISTS lives (
    user_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tracks_json TEXT NOT NULL
);

-- 配信用トークンを保存するテーブル
-- ユーザーあたり1つのトークンのみ発行可能
CREATE TABLE IF NOT EXISTS live_tokens (
    user_id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL
)
