import type { WHEPConnectionStatus } from "./session";

type WHEPRecoveringConnectionStatus = Exclude<
  WHEPConnectionStatus,
  "connected"
>;

type WHEPConnectingPlaybackState = {
  connectionStatus: WHEPRecoveringConnectionStatus;
  hasStream: false;
  phase: "connecting";
  resourceUserId: string;
};

type WHEPReconnectingPlaybackState = {
  connectionStatus: WHEPRecoveringConnectionStatus;
  hasStream: false;
  phase: "reconnecting";
  resourceUserId: string;
};

export type WHEPPlaybackState =
  | {
      connectionStatus: "disconnected";
      hasStream: false;
      phase: "idle";
      resourceUserId: null;
    }
  | WHEPConnectingPlaybackState
  | {
      connectionStatus: "connected";
      hasStream: boolean;
      phase: "connected";
      resourceUserId: string;
    }
  | WHEPReconnectingPlaybackState
  | {
      connectionStatus: "disconnected";
      hasStream: false;
      phase: "ended";
      resourceUserId: string;
    }
  | {
      connectionStatus: "failed";
      hasStream: false;
      phase: "error";
      resourceUserId: string;
    };

export function createDefaultPlaybackState(): WHEPPlaybackState {
  return {
    connectionStatus: "disconnected",
    hasStream: false,
    phase: "idle",
    resourceUserId: null,
  };
}

export function createPlaybackState(
  resourceUserId: string,
  phase: "connecting" | "reconnecting",
  connectionStatus: WHEPRecoveringConnectionStatus,
): WHEPConnectingPlaybackState | WHEPReconnectingPlaybackState {
  return {
    connectionStatus,
    hasStream: false,
    phase,
    resourceUserId,
  };
}
