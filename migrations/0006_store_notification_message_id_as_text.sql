-- Discord message ids are 64-bit snowflakes. D1 rejects JavaScript bigint bind
-- values and reads INTEGER columns back as lossy JavaScript numbers, so the id
-- is stored as decimal text instead.
CREATE TABLE lives_new (
    user_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tracks_json TEXT NOT NULL,
    notification_message_id TEXT
);

INSERT INTO lives_new (user_id, session_id, tracks_json, notification_message_id)
SELECT user_id, session_id, tracks_json, CAST(notification_message_id AS TEXT)
FROM lives;

DROP TABLE lives;

ALTER TABLE lives_new RENAME TO lives;
