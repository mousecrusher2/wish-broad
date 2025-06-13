-- D1データベースのスキーマ
-- liveidにつき1行で、TrackLocator配列のJSONを保存する

CREATE TABLE IF NOT EXISTS live_tracks (
    live_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tracks_json TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 更新日時を自動更新するトリガー
CREATE TRIGGER IF NOT EXISTS update_live_tracks_updated_at
    AFTER UPDATE ON live_tracks
    FOR EACH ROW
BEGIN
    UPDATE live_tracks SET updated_at = CURRENT_TIMESTAMP WHERE live_id = NEW.live_id;
END;

-- 配信用トークンを保存するテーブル
-- ユーザーあたり1つのトークンのみ発行可能
CREATE TABLE IF NOT EXISTS live_tokens (
    user_id TEXT PRIMARY KEY,
    token TEXT NOT NULL UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
