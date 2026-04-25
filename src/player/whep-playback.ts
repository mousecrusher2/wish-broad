import type { WHEPConnectionStatus } from "./WHEPClient";

type WHEPRecoveringConnectionStatus = Exclude<
  WHEPConnectionStatus,
  "connected"
>;

type WHEPConnectingPlaybackState = {
  connectionStatus: WHEPRecoveringConnectionStatus;
  hasStream: false;
  phase: "connecting";
  resourceUserId: string;
  retryCount: number;
};

type WHEPReconnectingPlaybackState = {
  connectionStatus: WHEPRecoveringConnectionStatus;
  hasStream: false;
  phase: "reconnecting";
  resourceUserId: string;
  retryCount: number;
};

export type WHEPPlaybackState =
  | {
      connectionStatus: "disconnected";
      hasStream: false;
      phase: "idle";
      resourceUserId: null;
      retryCount: 0;
    }
  | WHEPConnectingPlaybackState
  | {
      connectionStatus: "connected";
      hasStream: boolean;
      phase: "connected";
      resourceUserId: string;
      retryCount: 0;
    }
  | WHEPReconnectingPlaybackState
  | {
      connectionStatus: "disconnected";
      hasStream: false;
      phase: "ended";
      resourceUserId: string;
      retryCount: 0;
    }
  | {
      connectionStatus: "failed";
      hasStream: false;
      phase: "error";
      resourceUserId: string;
      retryCount: 0;
    };

type WHEPPlaybackPhase = WHEPPlaybackState["phase"];

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
  phase: "connecting" | "reconnecting",
  connectionStatus: WHEPRecoveringConnectionStatus,
  retryCount: number,
): WHEPConnectingPlaybackState | WHEPReconnectingPlaybackState {
  if (phase === "connecting") {
    return {
      connectionStatus,
      hasStream: false,
      phase,
      resourceUserId,
      retryCount,
    };
  }

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
