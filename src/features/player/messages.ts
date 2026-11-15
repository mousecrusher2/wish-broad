import type { WHEPPlaybackState } from "../../player/playback-state";

export function getPlaybackPhaseMessage(
  phase: WHEPPlaybackState["phase"],
): string {
  switch (phase) {
    case "idle":
      return "未接続";
    case "connected":
      return "接続済み";
    case "connecting":
      return "接続中...";
    case "reconnecting":
      return "再接続中...";
    case "ended":
      return "配信は終了しました";
    case "error":
      return "接続エラーが発生しました";
  }
}

export function getPlaybackPlaceholderText(
  playbackState: WHEPPlaybackState,
): string {
  switch (playbackState.phase) {
    case "idle":
      return "配信を選択して「Load」ボタンを押してください";
    case "connecting":
      return "接続中...";
    case "reconnecting":
      return "再接続中...";
    case "ended":
      return "配信は終了しました";
    case "error":
      return "接続エラーが発生しました";
    case "connected":
      return "映像を待機中...";
  }
}
