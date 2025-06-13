import { TrackLocator } from "./types";

// D1データベースでTrackLocatorを管理する関数群
export async function setTracks(database: D1Database, liveId: string, tracks: TrackLocator[]): Promise<void> {
  const tracksJson = JSON.stringify(tracks);
  await database
    .prepare(
      "INSERT OR REPLACE INTO live_tracks (live_id, tracks_json, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)"
    )
    .bind(liveId, tracksJson)
    .run();
}

export async function getTracks(database: D1Database, liveId: string): Promise<TrackLocator[]> {
  const result = await database
    .prepare("SELECT tracks_json FROM live_tracks WHERE live_id = ?")
    .bind(liveId)
    .first();

  if (!result) {
    return [];
  }

  return JSON.parse(result.tracks_json as string) as TrackLocator[];
}

export async function deleteTracks(database: D1Database, liveId: string): Promise<void> {
  await database
    .prepare("DELETE FROM live_tracks WHERE live_id = ?")
    .bind(liveId)
    .run();
}
