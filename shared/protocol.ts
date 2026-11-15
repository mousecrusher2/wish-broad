// Worker とクライアントの間の取り決め。両方のビルドに含まれるため、型と定数だけを置き、
// 実行時に何も import しない。

/** アプリのユーザー。`GET /api/me` の応答であり、配信一覧の配信者でもある。 */
export type User = {
  userId: string;
  displayName: string;
};

/** `GET /api/lives` の応答の要素。 */
export type LiveSummary = {
  owner: User;
};

/** `GET /api/me/livetoken` の応答。既存のトークン値は含めない。 */
export type LiveTokenStatus = {
  hasToken: boolean;
};

/** `POST /api/me/livetoken` の応答。生のトークンを返すのはこのときだけ。 */
export type CreatedLiveToken = {
  success: true;
  token: string;
};

/**
 * `POST /play/:userId` の応答で、インジェストが保存したトラック数を伝えるヘッダー。
 * クライアントはこれより少ないトラックしか得られなかった再生を不完全とみなす。
 */
export const LIVE_TRACK_COUNT_HEADER = "Wish-Live-Track-Count";

/** 配信者の再接続待ちを示す `409` の `Retry-After`（秒）。プレーヤーはこの間隔で固定リトライする。 */
export const LIVE_RECONNECTING_RETRY_AFTER_SECONDS = 2;

/**
 * インジェストの DELETE 後も配信を維持する再接続猶予期間。この期間内の新しいインジェストは
 * 開始通知を送らずに配信を再開する（docs/architecture.md「インジェストのライフサイクル」）。
 */
export const LIVE_RECONNECT_GRACE_MS = 60_000;
