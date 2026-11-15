// 配信のライフサイクルで Worker と LiveState の間を受け渡す値。LiveState からも import
// するため、型だけを置く。
import type { SfuTrack } from "../clients/sfu";

/** 配信行に保存するインジェストトラック。再生セッションはこれにアタッチする。 */
export type StoredTrack = SfuTrack;

/** 配信者ごとに 1 つ存在する配信（`lives` の 1 行）。 */
export type LiveRecord = {
  /** OBS の再接続をまたいで変わらない配信 ID。 */
  broadcastId: string;
  /** 再接続猶予期間の終了時刻（Unix エポックミリ秒）。インジェストセッションが配信中なら null。 */
  graceExpiresAt: number | null;
  /**
   * リクエストが SFU 上でインジェストセッションの生存を最後に確認した時刻
   * （Unix エポックミリ秒）。このセッションでまだ確認がなければ null。
   */
  sessionSeenActiveAt: number | null;
  userId: string;
  /** 現在の SFU インジェストセッション。再接続のたびに置き換わる。 */
  sessionId: string;
  /** `sessionId` のトラック。再接続のたびに置き換わる。 */
  tracks: StoredTrack[];
};

/** Worker が Discord から削除すべき開始通知。 */
export type NotificationDeleteJob = {
  /** Discord snowflake（10 進数文字列）。 */
  messageId: string;
  userId: string;
};
