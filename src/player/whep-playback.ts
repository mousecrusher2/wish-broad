import type { WHEPConnectionStatus } from "./WHEPClient";

export type WHEPPlaybackPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "error";

export type WHEPPlaybackState = {
  connectionStatus: WHEPConnectionStatus;
  hasStream: boolean;
  phase: WHEPPlaybackPhase;
  resourceUserId: string | null;
  retryCount: number;
};

function assertUnreachablePhase(phase: never): never {
  void phase;
  throw new Error("Unexpected playback phase");
}

export function createDefaultPlaybackState(): WHEPPlaybackState {
  return {
    connectionStatus: "disconnected",
    hasStream: false,
    phase: "idle",
    resourceUserId: null,
    retryCount: 0,
  };
}

export function createPlaybackState(
  resourceUserId: string,
  phase: WHEPPlaybackPhase,
  connectionStatus: WHEPConnectionStatus,
  retryCount: number,
): WHEPPlaybackState {
  return {
    connectionStatus,
    hasStream: false,
    phase,
    resourceUserId,
    retryCount,
  };
}

export function getPlaybackPhaseMessage(
  phase: WHEPPlaybackPhase,
): string | null {
  switch (phase) {
    case "idle":
    case "connected":
      return null;
    case "connecting":
      return "接続中...";
    case "reconnecting":
      return "再接続中...";
    case "ended":
      return "配信は終了しました";
    case "error":
      return "接続エラーが発生しました";
    default:
      return assertUnreachablePhase(phase);
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
    default:
      return assertUnreachablePhase(playbackState.phase);
  }
}
