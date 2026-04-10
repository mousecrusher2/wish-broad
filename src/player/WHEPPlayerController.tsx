import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { RefObject } from "react";
import { WHEPClient, type WHEPConnectionStatus } from "./WHEPClient";

export type WHEPPlayerControllerHandle = {
  connect: (resourceUserId: string) => Promise<void>;
  disconnect: () => Promise<void>;
};

type WHEPPlayerControllerProps = {
  videoRef: RefObject<HTMLVideoElement | null>;
  onError?: (error: Error) => void;
  onLoadingChange?: (isLoading: boolean) => void;
  onStatusChange?: (status: WHEPConnectionStatus) => void;
  onStreamChange?: (hasStream: boolean) => void;
};

type CurrentCallbacks = {
  onError: ((error: Error) => void) | undefined;
  onLoadingChange: ((isLoading: boolean) => void) | undefined;
  onStatusChange: ((status: WHEPConnectionStatus) => void) | undefined;
  onStreamChange: ((hasStream: boolean) => void) | undefined;
};

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

export const WHEPPlayerController = forwardRef<
  WHEPPlayerControllerHandle,
  WHEPPlayerControllerProps
>(function WHEPPlayerController(
  { videoRef, onError, onLoadingChange, onStatusChange, onStreamChange },
  ref,
) {
  const playerRef = useRef<WHEPClient | null>(null);
  const callbacksRef = useRef<CurrentCallbacks>({
    onError: undefined,
    onLoadingChange: undefined,
    onStatusChange: undefined,
    onStreamChange: undefined,
  });

  callbacksRef.current = {
    onError,
    onLoadingChange,
    onStatusChange,
    onStreamChange,
  };

  useEffect(() => {
    const videoElement = videoRef.current;
    if (!videoElement) {
      return;
    }

    const player = new WHEPClient(videoElement, {
      onStatusChange: (status) => {
        callbacksRef.current.onStatusChange?.(status);
      },
      onStreamChange: (hasStream) => {
        callbacksRef.current.onStreamChange?.(hasStream);
      },
    });

    playerRef.current = player;

    return () => {
      void player.dispose();
      if (playerRef.current === player) {
        playerRef.current = null;
      }
    };
  }, [videoRef]);

  useImperativeHandle(
    ref,
    () => ({
      async connect(resourceUserId: string) {
        const player = playerRef.current;
        if (!player || !resourceUserId.trim()) {
          return;
        }

        callbacksRef.current.onLoadingChange?.(true);
        try {
          await player.connect(resourceUserId);
        } catch (error) {
          callbacksRef.current.onError?.(normalizeError(error));
        } finally {
          callbacksRef.current.onLoadingChange?.(false);
        }
      },
      async disconnect() {
        await playerRef.current?.disconnect();
      },
    }),
    [],
  );

  return null;
});
