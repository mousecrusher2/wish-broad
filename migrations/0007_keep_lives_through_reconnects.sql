-- A broadcast now survives OBS reconnects. DELETE starts a reconnect grace
-- period (grace_expires_at) instead of removing the row, and the start
-- notification is tied to broadcast_id rather than to the ingest session.
CREATE TABLE lives_new (
    user_id TEXT PRIMARY KEY,
    broadcast_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    tracks_json TEXT NOT NULL,
    notification_message_id TEXT,
    grace_expires_at INTEGER
);

INSERT INTO lives_new (
    user_id,
    broadcast_id,
    session_id,
    tracks_json,
    notification_message_id,
    grace_expires_at
)
SELECT
    user_id,
    lower(hex(randomblob(16))),
    session_id,
    tracks_json,
    notification_message_id,
    NULL
FROM lives;

DROP TABLE lives;

ALTER TABLE lives_new RENAME TO lives;
