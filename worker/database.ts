import { TrackLocator } from "./types";

// D1データベースでTrackLocatorを管理する関数群
export async function setTracks(
  database: D1Database,
  liveId: string,
  sessionId: string,
  tracks: TrackLocator[]
): Promise<void> {
  const tracksJson = JSON.stringify(tracks);
  await database
    .prepare(
      "INSERT OR REPLACE INTO live_tracks (live_id, session_id, tracks_json, updated_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)"
    )
    .bind(liveId, sessionId, tracksJson)
    .run();
}

export async function getTracks(
  database: D1Database,
  liveId: string
): Promise<TrackLocator[]> {
  const result = await database
    .prepare("SELECT tracks_json FROM live_tracks WHERE live_id = ?")
    .bind(liveId)
    .first();

  if (!result) {
    return [];
  }

  return JSON.parse(result.tracks_json as string) as TrackLocator[];
}

export async function deleteTracks(
  database: D1Database,
  liveId: string
): Promise<void> {
  await database
    .prepare("DELETE FROM live_tracks WHERE live_id = ?")
    .bind(liveId)
    .run();
}

/**
 * セッションチェックが必要かどうかを判定
 * 最後のチェックから10秒以上経過している場合のみtrue
 */
export async function shouldCheckSession(
  database: D1Database,
  liveId: string
): Promise<boolean> {
  const result = await database
    .prepare("SELECT last_session_check FROM live_tracks WHERE live_id = ?")
    .bind(liveId)
    .first();

  if (!result || !result.last_session_check) {
    return true; // チェック記録がない場合はチェックが必要
  }

  const lastCheck = new Date(result.last_session_check as string);
  const now = new Date();
  const diffInSeconds = (now.getTime() - lastCheck.getTime()) / 1000;

  return diffInSeconds >= 10; // 10秒以上経過していればチェックが必要
}

/**
 * セッションチェック時刻を更新
 */
export async function updateSessionCheckTime(
  database: D1Database,
  liveId: string
): Promise<void> {
  await database
    .prepare(
      "UPDATE live_tracks SET last_session_check = CURRENT_TIMESTAMP WHERE live_id = ?"
    )
    .bind(liveId)
    .run();
}

/**
 * セッションが非アクティブだった場合のレコード削除
 */
export async function deleteInactiveSession(
  database: D1Database,
  liveId: string
): Promise<void> {
  await database
    .prepare("DELETE FROM live_tracks WHERE live_id = ?")
    .bind(liveId)
    .run();
}

// 配信用トークンの管理機能
export async function setLiveToken(
  database: D1Database,
  userId: string,
  token: string
): Promise<void> {
  await database
    .prepare(
      "INSERT OR REPLACE INTO live_tokens (user_id, token, created_at) VALUES (?, ?, CURRENT_TIMESTAMP)"
    )
    .bind(userId, token)
    .run();
}

export async function getLiveToken(
  database: D1Database,
  userId: string
): Promise<string | null> {
  const result = await database
    .prepare("SELECT token FROM live_tokens WHERE user_id = ?")
    .bind(userId)
    .first();

  return result ? (result.token as string) : null;
}

export async function hasLiveToken(
  database: D1Database,
  userId: string
): Promise<boolean> {
  const result = await database
    .prepare("SELECT 1 FROM live_tokens WHERE user_id = ? LIMIT 1")
    .bind(userId)
    .first();

  return !!result;
}
