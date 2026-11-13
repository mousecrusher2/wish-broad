-- OBS can lose an ingest session without sending DELETE (a crash or network
-- loss). Remember when a request last found the session active in Calls, so a
-- request that later finds it garbage-collected can tell that it was lost just
-- now and keep the broadcast for OBS to resume.
ALTER TABLE lives ADD COLUMN session_seen_active_at INTEGER;
