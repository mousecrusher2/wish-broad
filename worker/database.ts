import { Live, StoredTrack, TrackLocator, User } from "./types";
import { parseLiveTrackRow, parseStoredTracksJson } from "./validation";

export type LiveTrackRecord = {
  userId: string;
  sessionId: string;
  tracks: StoredTrack[];
};

// D1データベースでTrackLocatorを管理する関数群
export async function setTracks(
  database: D1Database,
  userId: string,
  sessionId: string,
  tracks: StoredTrack[],
): Promise<void> {
  const tracksJson = JSON.stringify(tracks);
  await database
    .prepare(
      "INSERT OR REPLACE INTO live_tracks (user_id, session_id, tracks_json) VALUES (?, ?, ?)",
    )
    .bind(userId, sessionId, tracksJson)
    .run();
}

export async function getLiveTrackRecord(
  database: D1Database,
  userId: string,
): Promise<LiveTrackRecord | null> {
  const result = await database
    .prepare(
      "SELECT user_id, session_id, tracks_json FROM live_tracks WHERE user_id = ?",
    )
    .bind(userId)
    .first();

  if (!result) {
    return null;
  }

  const row = parseLiveTrackRow(result, "D1 live_tracks row");

  return {
    userId: row.user_id,
    sessionId: row.session_id,
    tracks: parseStoredTracksJson(
      row.tracks_json,
      "D1 live_tracks.tracks_json",
    ),
  };
}

export async function getTracks(
  database: D1Database,
  userId: string,
): Promise<TrackLocator[]> {
  const liveTrackRecord = await getLiveTrackRecord(database, userId);
  return (
    liveTrackRecord?.tracks.map(({ location, sessionId, trackName }) => ({
      location,
      sessionId,
      trackName,
    })) ?? []
  );
}

export async function deleteTracksForSession(
  database: D1Database,
  userId: string,
  sessionId: string,
): Promise<boolean> {
  const result = await database
    .prepare("DELETE FROM live_tracks WHERE user_id = ? AND session_id = ?")
    .bind(userId, sessionId)
    .run();

  return result.meta.changes > 0;
}

// 配信用トークンの管理機能
export async function setLiveToken(
  database: D1Database,
  userId: string,
  token: string,
): Promise<void> {
  await database
    .prepare(
      "INSERT OR REPLACE INTO live_tokens (user_id, token) VALUES (?, ?)",
    )
    .bind(userId, token)
    .run();
}

export async function getLiveToken(
  database: D1Database,
  userId: string,
): Promise<string | null> {
  const result = await database
    .prepare("SELECT token FROM live_tokens WHERE user_id = ?")
    .bind(userId)
    .first();

  return result ? (result["token"] as string) : null;
}

export async function hasLiveToken(
  database: D1Database,
  userId: string,
): Promise<boolean> {
  const result = await database
    .prepare("SELECT 1 FROM live_tokens WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first();

  return !!result;
}

export async function setUser(database: D1Database, user: User): Promise<void> {
  await database
    .prepare(
      "INSERT OR REPLACE INTO users (user_id, display_name) VALUES (?, ?)",
    )
    .bind(user.userId, user.displayName)
    .run();
}

export async function getUser(
  database: D1Database,
  userId: string,
): Promise<User | null> {
  const result = await database
    .prepare("SELECT user_id, display_name FROM users WHERE user_id = ?")
    .bind(userId)
    .first();

  if (!result) {
    return null;
  }

  return {
    userId: result["user_id"] as string,
    displayName: result["display_name"] as string,
  };
}

export async function getAllLives(database: D1Database): Promise<Live[]> {
  const results = await database
    .prepare(
      "SELECT users.user_id, display_name FROM live_tracks JOIN users ON live_tracks.user_id = users.user_id",
    )
    .all();

  return results.results.map((row) => ({
    owner: {
      userId: row["user_id"] as string,
      displayName: row["display_name"] as string,
    },
  }));
}
