import type { StoredTrack, TrackLocator } from "./calls";
import * as v from "valibot";

export type User = {
  userId: string;
  displayName: string;
};

export type Live = {
  owner: User;
};

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
  const liveTrackRowSchema = v.object({
    user_id: v.string(),
    session_id: v.string(),
    tracks_json: v.string(),
  });
  const storedTrackSchema = v.object({
    location: v.literal("remote"),
    sessionId: v.string(),
    trackName: v.string(),
    mid: v.string(),
  });
  const storedTracksSchema = v.array(storedTrackSchema);

  const result = await database
    .prepare(
      "SELECT user_id, session_id, tracks_json FROM live_tracks WHERE user_id = ?",
    )
    .bind(userId)
    .first();

  if (!result) {
    return null;
  }

  const rowResult = v.safeParse(liveTrackRowSchema, result);
  if (!rowResult.success) {
    throw new Error("Invalid D1 live_tracks row");
  }
  const row = rowResult.output;

  const parsedTracksInput: unknown = JSON.parse(row.tracks_json);
  const tracksResult = v.safeParse(storedTracksSchema, parsedTracksInput);
  if (!tracksResult.success) {
    throw new Error("Invalid D1 live_tracks.tracks_json");
  }

  return {
    userId: row.user_id,
    sessionId: row.session_id,
    tracks: tracksResult.output,
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
  tokenHash: string,
): Promise<void> {
  await database
    .prepare(
      "INSERT OR REPLACE INTO live_tokens (user_id, token_hash) VALUES (?, ?)",
    )
    .bind(userId, tokenHash)
    .run();
}

export async function getLiveTokenHash(
  database: D1Database,
  userId: string,
): Promise<string | null> {
  const liveTokenRowSchema = v.object({
    token_hash: v.string(),
  });

  const result = await database
    .prepare("SELECT token_hash FROM live_tokens WHERE user_id = ?")
    .bind(userId)
    .first();

  if (!result) {
    return null;
  }

  const rowResult = v.safeParse(liveTokenRowSchema, result);
  if (!rowResult.success) {
    throw new Error("Invalid D1 live_tokens row");
  }

  return rowResult.output.token_hash;
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
  const userRowSchema = v.object({
    user_id: v.string(),
    display_name: v.string(),
  });

  const result = await database
    .prepare("SELECT user_id, display_name FROM users WHERE user_id = ?")
    .bind(userId)
    .first();

  if (!result) {
    return null;
  }

  const rowResult = v.safeParse(userRowSchema, result);
  if (!rowResult.success) {
    throw new Error("Invalid D1 users row");
  }
  const row = rowResult.output;

  return {
    userId: row.user_id,
    displayName: row.display_name,
  };
}

export async function getAllLives(database: D1Database): Promise<Live[]> {
  const liveListRowSchema = v.object({
    user_id: v.string(),
    display_name: v.string(),
  });

  const results = await database
    .prepare(
      "SELECT users.user_id, display_name FROM live_tracks JOIN users ON live_tracks.user_id = users.user_id",
    )
    .all();

  return results.results.map((row) => {
    const rowResult = v.safeParse(liveListRowSchema, row);
    if (!rowResult.success) {
      throw new Error("Invalid D1 live list row");
    }
    const parsedRow = rowResult.output;

    return {
      owner: {
        userId: parsedRow.user_id,
        displayName: parsedRow.display_name,
      },
    };
  });
}
