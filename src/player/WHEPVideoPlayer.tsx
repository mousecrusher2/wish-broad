import { useCallback, useEffect, useState } from "react";
import type { RefCallback } from "react";
import { WHEPSession, type WHEPConnectionStatus } from "./WHEPClient";

export type WHEPVideoPlayerHandlers = {
  load: (resourceUserId: string) => void;
  disconnect: () => void;
};

type WHEPVideoPlayerProps = {
  onError?: (error: Error) => void;
  onHandlersChange?: (handlers: WHEPVideoPlayerHandlers) => void;
  onLoadingChange?: (isLoading: boolean) => void;
  onStatusChange?: (status: WHEPConnectionStatus) => void;
};

type PlaybackRequest =
  | { kind: "idle" }
  | { kind: "requested"; requestId: number; resourceUserId: string };

type WHEPSessionVideoProps = {
  onError?: (error: Error) => void;
  onLoadingChange?: (isLoading: boolean) => void;
  onStatusChange?: (status: WHEPConnectionStatus) => void;
  resourceUserId: string;
};

type VideoElementState =
  | { kind: "unmounted" }
  | { kind: "mounted"; element: HTMLVideoElement };

function noop(): void {}

const noopWHEPVideoPlayerHandlers: WHEPVideoPlayerHandlers = {
  load: noop,
  disconnect: noop,
};

function getNextRequestId(playbackRequest: PlaybackRequest): number {
  if (playbackRequest.kind === "idle") {
    return 1;
  }

  return playbackRequest.requestId + 1;
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(String(error));
}

function VideoPlaceholder() {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm leading-7 text-slate-400">
      配信を選択して「Load」ボタンを押してください
    </div>
  );
}

function WHEPSessionVideo({
  onError,
  onLoadingChange,
  onStatusChange,
  resourceUserId,
}: WHEPSessionVideoProps) {
  const [hasStream, setHasStream] = useState(false);
  const [videoElement, setVideoElement] = useState<VideoElementState>({
    kind: "unmounted",
  });

  const mountVideo = useCallback<RefCallback<HTMLVideoElement>>(
    (mountedVideoElement) => {
      if (mountedVideoElement) {
        setVideoElement({ kind: "mounted", element: mountedVideoElement });
        return;
      }

      setVideoElement({ kind: "unmounted" });
    },
    [],
  );

  useEffect(() => {
    if (videoElement.kind !== "mounted") {
      return;
    }

    let mounted = true;
    const session = new WHEPSession({
      callbacks: {
        onStreamChange: (nextHasStream) => {
          if (mounted) {
            setHasStream(nextHasStream);
          }
        },
        ...(onStatusChange
          ? {
              onStatusChange: (status: WHEPConnectionStatus) => {
                if (mounted) {
                  onStatusChange(status);
                }
              },
            }
          : {}),
      },
      resourceUserId,
      videoElement: videoElement.element,
    });

    onLoadingChange?.(true);
    void session
      .start()
      .catch((error) => {
        if (mounted) {
          onError?.(normalizeError(error));
        }
      })
      .finally(() => {
        if (mounted) {
          onLoadingChange?.(false);
        }
      });

    return () => {
      mounted = false;
      void session.dispose({ notifyServer: true });
    };
  }, [onError, onLoadingChange, onStatusChange, resourceUserId, videoElement]);

  return (
    <>
      <video
        ref={mountVideo}
        className={`aspect-video w-full bg-black object-contain ${hasStream ? "opacity-100" : "opacity-0"}`}
        controls={hasStream}
        autoPlay
        muted
        playsInline
      />
      {!hasStream && <VideoPlaceholder />}
    </>
  );
}

export function WHEPVideoPlayer({
  onError,
  onHandlersChange,
  onLoadingChange,
  onStatusChange,
}: WHEPVideoPlayerProps) {
  const [playbackRequest, setPlaybackRequest] = useState<PlaybackRequest>({
    kind: "idle",
  });

  const load = useCallback((resourceUserId: string) => {
    const trimmedResourceUserId = resourceUserId.trim();
    if (trimmedResourceUserId.length === 0) {
      return;
    }

    setPlaybackRequest((currentPlaybackRequest) => ({
      kind: "requested",
      requestId: getNextRequestId(currentPlaybackRequest),
      resourceUserId: trimmedResourceUserId,
    }));
  }, []);

  const disconnect = useCallback(() => {
    onLoadingChange?.(false);
    onStatusChange?.("disconnected");
    setPlaybackRequest({ kind: "idle" });
  }, [onLoadingChange, onStatusChange]);

  useEffect(() => {
    onHandlersChange?.({ load, disconnect });

    return () => {
      onHandlersChange?.(noopWHEPVideoPlayerHandlers);
    };
  }, [disconnect, load, onHandlersChange]);

  return (
    <section className="rounded-4xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-black/20 backdrop-blur">
      <div className="mb-4">
        <p className="text-sm font-medium tracking-[0.3em] text-cyan-300/80 uppercase">
          Playback
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
          配信映像
        </h2>
      </div>
      <div className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-black/70 shadow-2xl shadow-black/30">
        <div className="absolute inset-x-0 top-0 z-10 h-1 bg-linear-to-r from-cyan-400 via-blue-500 to-emerald-400" />
        {playbackRequest.kind === "requested" ? (
          <WHEPSessionVideo
            key={playbackRequest.requestId}
            {...(onError ? { onError } : {})}
            {...(onLoadingChange ? { onLoadingChange } : {})}
            {...(onStatusChange ? { onStatusChange } : {})}
            resourceUserId={playbackRequest.resourceUserId}
          />
        ) : (
          <VideoPlaceholder />
        )}
      </div>
    </section>
  );
}
