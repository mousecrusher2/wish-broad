import {
  createContext,
  useContext,
} from "react";
import type { WHEPPlaybackControllerSnapshot } from "./player/WHEPPlaybackController";

export type WHEPPlayerContextValue = {
  attachVideoElement: (videoElement: HTMLVideoElement | null) => void;
  disconnect: () => void;
  loadSelectedResource: () => void;
  reconnect: () => void;
  resource: string;
  setResource: (resource: string) => void;
  snapshot: WHEPPlaybackControllerSnapshot;
};

export const WHEPPlayerContext = createContext<WHEPPlayerContextValue | null>(
  null,
);

export function useWHEPPlayerContext(): WHEPPlayerContextValue {
  const context = useContext(WHEPPlayerContext);
  if (context) {
    return context;
  }

  throw new Error("WHEPPlayerContext is not available");
}
