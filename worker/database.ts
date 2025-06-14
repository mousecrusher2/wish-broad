import { Live, TrackLocator, User } from "./types";

// D1データベースでTrackLocatorを管理する関数群
export async function setTracks(
  database: D1Database,
  userId: string,
  sessionId: string,
  tracks: TrackLocator[]
): Promise<void> {
  const tracksJson = JSON.stringify(tracks);
  await database
    .prepare(
      "INSERT OR REPLACE INTO live_tracks (user_id, session_id, tracks_json) VALUES (?, ?, ?)"
    )
    .bind(userId, sessionId, tracksJson)
    .run();
}

export async function getTracks(
  database: D1Database,
  userId: string
): Promise<TrackLocator[]> {
  const result = await database
    .prepare("SELECT tracks_json FROM live_tracks WHERE user_id = ?")
    .bind(userId)
    .first();

  if (!result) {
    return [];
  }

  return JSON.parse(result.tracks_json as string) as TrackLocator[];
}

export async function deleteTracks(
  database: D1Database,
  userId: string
): Promise<void> {
  await database
    .prepare("DELETE FROM live_tracks WHERE user_id = ?")
    .bind(userId)
    .run();
}

/**
 * セッションチェックが必要かどうかを判定
 * 最後のチェックから10秒以上経過している場合のみtrue
 */
export async function shouldCheckSession(
  database: D1Database,
  userId: string
): Promise<boolean> {
  const result = await database
    .prepare("SELECT last_session_check FROM live_tracks WHERE user_id = ?")
    .bind(userId)
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
  userId: string
): Promise<void> {
  await database
    .prepare(
      "UPDATE live_tracks SET last_session_check = CURRENT_TIMESTAMP WHERE user_id = ?"
    )
    .bind(userId)
    .run();
}

/**
 * セッションが非アクティブだった場合のレコード削除
 */
export async function deleteInactiveSession(
  database: D1Database,
  userId: string
): Promise<void> {
  await database
    .prepare("DELETE FROM live_tracks WHERE user_id = ?")
    .bind(userId)
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
      "INSERT OR REPLACE INTO live_tokens (user_id, token) VALUES (?, ?)"
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

export async function setUser(database: D1Database, user: User): Promise<void> {
  await database
    .prepare(
      "INSERT OR REPLACE INTO users (user_id, display_name) VALUES (?, ?)"
    )
    .bind(user.userId, user.displayName)
    .run();
}

export async function getUser(
  database: D1Database,
  userId: string
): Promise<User | null> {
  const result = await database
    .prepare("SELECT user_id, display_name FROM users WHERE user_id = ?")
    .bind(userId)
    .first();

  if (!result) {
    return null;
  }

  return {
    userId: result.user_id as string,
    displayName: result.display_name as string,
  };
}

export async function getAllLives(database: D1Database): Promise<Live[]> {
  const results = await database
    .prepare(
      "SELECT users.user_id, display_name FROM live_tracks JOIN users ON live_tracks.user_id = users.user_id"
    )
    .all();

  return results.results.map((row) => ({
    owner: {
      userId: row.user_id as string,
      displayName: row.display_name as string,
    },
  }));
}
