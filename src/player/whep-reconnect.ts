import { WHEPSessionError, type WHEPSessionSnapshot } from "./WHEPClient";

// 配信がまだ継続中かどうかは Worker が明示する（配信者の再接続待ちは
// `Retry-After: 2` 付きの 503、配信終了後は 404）ため、クライアントは推測のために
// バックオフせず同じ固定間隔でリトライする。
export const WHEP_RECONNECT_DELAY_MS = 2_000;

// Worker は SFU を継続的にポーリングしないため、リカバリーは視聴者主導で行う。
// 予定された終了処理が動いていなくても、60 秒間の配信者再接続猶予期間
// （worker/live-end.ts）を過ぎると Worker は POST /play に 404 を返すため、
// 通常はそこで再生が終了する。このウィンドウは、サーバーが失敗し続けたり 503 を
// 返し続けたりして壊れた配信を永遠にポーリングし続けないための安全網であり、
// 猶予期間より長く設定する必要がある。
export const WHEP_RECONNECT_WINDOW_MS = 75_000;

// メディアの疎通確認にはレシーバーの統計情報を信頼できる基準とする。WHEP セッションを
// 不完全とみなして置き換える前に、想定されるすべての受信側 RTP レシーバーが揃うまで
// 十分な時間待機する。
export const WHEP_TRACK_DISCOVERY_GRACE_MS = 15_000;

// セッションがいったん接続された後は、WHEP セッションを置き換える前に、ブラウザが
// 安定した disconnected または failed 状態を報告するまで待機する。メディアの停止は
// この上位レイヤーにあるより短い間隔の bytesReceived モニターが検知する。
export const WHEP_SESSION_RECOVERY_GRACE_MS = 3_000;

type WHEPReconnectDisposition = "ended" | "error" | "retry";
export type WHEPReconnectAttemptMode = "initial" | "retry";

export function resolveReconnectDisposition(
  error: unknown,
): WHEPReconnectDisposition {
  if (error instanceof WHEPSessionError) {
    if (error.isNotFound()) {
      return "ended";
    }

    if (!error.retryable || error.isClientRequestError()) {
      return "error";
    }
  }

  return "retry";
}

export function shouldRecoverEstablishedSession(
  snapshot: WHEPSessionSnapshot,
): snapshot is WHEPSessionSnapshot & {
  status: "disconnected" | "failed";
} {
  return snapshot.status === "disconnected" || snapshot.status === "failed";
}

export function shouldReconnectForPlaybackStall(stalledForMs: number): boolean {
  return stalledForMs >= 3_000;
}

export function shouldReconnectForTrackDiscoveryTimeout(
  waitingForExpectedTracksMs: number,
): boolean {
  return waitingForExpectedTracksMs >= WHEP_TRACK_DISCOVERY_GRACE_MS;
}
