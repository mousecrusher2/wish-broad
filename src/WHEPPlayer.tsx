import { useCallback, useState } from "react";
import type { WHEPPlayerProps } from "./types";
import { useLiveStreams } from "./useLiveStreams";
import { OBSStreamingInfo } from "./OBSStreamingInfo";
import { ConnectionControls } from "./components/ConnectionControls";
import { StreamSelection } from "./components/StreamSelection";
import {
  WHEPVideoPlayer,
  type WHEPPlaybackState,
  type WHEPVideoPlayerHandlers,
} from "./player/WHEPVideoPlayer";

function noop(): void {}

const noopWHEPVideoPlayerHandlers: WHEPVideoPlayerHandlers = {
  load: noop,
  disconnect: noop,
};

function createIdlePlaybackState(): WHEPPlaybackState {
  return {
    connectionStatus: "disconnected",
    hasStream: false,
    message: null,
    phase: "idle",
    resourceUserId: null,
    retryCount: 0,
  };
}

export function WHEPPlayer({ user }: WHEPPlayerProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [resource, setResource] = useState("");
  const [playbackState, setPlaybackState] = useState<WHEPPlaybackState>(
    createIdlePlaybackState,
  );
  const [playerHandlers, setPlayerHandlers] = useState<WHEPVideoPlayerHandlers>(
    noopWHEPVideoPlayerHandlers,
  );

  // ライブストリーム取得
  const {
    streams,
    isLoading: streamsLoading,
    error: streamsError,
    refresh,
  } = useLiveStreams();

  const load = useCallback(
    (resourceToLoad: string) => {
      playerHandlers.load(resourceToLoad);
    },
    [playerHandlers],
  );

  const handlePlayerHandlersChange = useCallback(
    (nextHandlers: WHEPVideoPlayerHandlers) => {
      setPlayerHandlers(nextHandlers);
    },
    [],
  );

  const handlePlayerError = useCallback((error: Error) => {
    console.error("Failed to load stream:", error);
  }, []);

  const handleReconnect = useCallback(() => {
    load(resource);
  }, [resource, load]);

  const handleDisconnect = useCallback(() => {
    playerHandlers.disconnect();
  }, [playerHandlers]);

  const handleLoadClick = useCallback(() => {
    load(resource);
  }, [resource, load]);
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-4 rounded-4xl border border-white/10 bg-slate-900/70 px-5 py-5 shadow-xl shadow-black/20 backdrop-blur md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-sm font-medium tracking-[0.3em] text-cyan-300/80 uppercase">
            Live Viewer
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            WHEP Player
          </h1>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-100">
            ようこそ、<span className="font-semibold">{user.displayName}</span>{" "}
            さん
          </div>
          <form method="POST" action="/logout">
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/90 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-400"
            >
              ログアウト
            </button>
          </form>
        </div>
      </header>
      <StreamSelection
        resource={resource}
        setResource={setResource}
        streams={streams}
        isLoading={isLoading}
        error={streamsError}
        onRefresh={refresh}
        onLoadClick={handleLoadClick}
        streamsLoading={streamsLoading}
      />
      <ConnectionControls
        connectionPhase={playbackState.phase}
        connectionStatus={playbackState.connectionStatus}
        hasResource={!!resource.trim()}
        onReconnect={handleReconnect}
        onDisconnect={handleDisconnect}
        statusMessage={playbackState.message}
      />
      <WHEPVideoPlayer
        onError={handlePlayerError}
        onHandlersChange={handlePlayerHandlersChange}
        onLoadingChange={setIsLoading}
        onPlaybackStateChange={setPlaybackState}
      />
      <OBSStreamingInfo user={user} />
    </div>
  );
}
