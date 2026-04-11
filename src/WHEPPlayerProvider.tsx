import {
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { WHEPPlayerContext } from "./WHEPPlayerContext";
import {
  WHEPPlaybackController,
  type WHEPPlaybackControllerSnapshot,
} from "./player/WHEPPlaybackController";
import { createIdlePlaybackState } from "./player/whep-playback";

function createIdleSnapshot(): WHEPPlaybackControllerSnapshot {
  return {
    isLoading: false,
    playbackState: createIdlePlaybackState(),
  };
}

export function WHEPPlayerProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new WHEPPlaybackController());
  const [resource, setResource] = useState("");
  const [snapshot, setSnapshot] =
    useState<WHEPPlaybackControllerSnapshot>(createIdleSnapshot);

  useEffect(() => {
    const subscriber = setSnapshot;
    controller.setSnapshotSubscriber(subscriber);

    return () => {
      controller.unsetSnapshotSubscriber(subscriber);
      controller.dispose();
    };
  }, [controller]);

  const loadResource = useCallback(
    (resourceUserId: string) => {
      const trimmedResourceUserId = resourceUserId.trim();
      if (trimmedResourceUserId.length === 0) {
        return;
      }

      controller.load(trimmedResourceUserId);
    },
    [controller],
  );

  const loadSelectedResource = useCallback(() => {
    loadResource(resource);
  }, [loadResource, resource]);

  const reconnect = useCallback(() => {
    loadResource(resource);
  }, [loadResource, resource]);

  const disconnect = useCallback(() => {
    controller.disconnect();
  }, [controller]);

  const attachVideoElement = useCallback(
    (videoElement: HTMLVideoElement | null) => {
      controller.attachVideoElement(videoElement);
    },
    [controller],
  );

  return (
    <WHEPPlayerContext.Provider
      value={{
        attachVideoElement,
        disconnect,
        loadSelectedResource,
        reconnect,
        resource,
        setResource,
        snapshot,
      }}
    >
      {children}
    </WHEPPlayerContext.Provider>
  );
}
