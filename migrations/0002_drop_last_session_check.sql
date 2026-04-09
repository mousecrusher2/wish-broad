CREATE TABLE live_tracks_new (
    user_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    tracks_json TEXT NOT NULL
);

INSERT INTO live_tracks_new (user_id, session_id, tracks_json)
SELECT user_id, session_id, tracks_json
FROM live_tracks;

DROP TABLE live_tracks;

ALTER TABLE live_tracks_new RENAME TO live_tracks;
