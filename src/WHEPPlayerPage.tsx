import { useCallback, useState } from "react";
import type { User } from "./types";
import { OBSStreamingInfo } from "./OBSStreamingInfo";
import { ConnectionControls } from "./components/ConnectionControls";
import { StreamSelection } from "./components/StreamSelection";
import { WHEPPlayer } from "./WHEPPlayer";
import { useWHEPPlayerContext } from "./WHEPPlayerContext";
import { WHEPPlayerProvider } from "./WHEPPlayerProvider";
import type { WHEPPlaybackControllerSnapshot } from "./player/WHEPPlaybackController";
import { createIdlePlaybackState } from "./player/whep-playback";
import { useLiveStreams } from "./useLiveStreams";

function createIdleSnapshot(): WHEPPlaybackControllerSnapshot {
  return {
    isLoading: false,
    playbackState: createIdlePlaybackState(),
  };
}

function WHEPPlayerPageContent({ user }: { user: User }) {
  const { resource, setResource } = useWHEPPlayerContext();
  const [activeResource, setActiveResource] = useState<string | null>(null);
  const [playerSnapshot, setPlayerSnapshot] = useState<WHEPPlaybackControllerSnapshot>(
    createIdleSnapshot,
  );

  const {
    streams,
    isLoading: streamsLoading,
    error: streamsError,
    refresh,
  } = useLiveStreams();

  const handleResourceChange = useCallback((nextResource: string) => {
    setResource(nextResource);
  }, [setResource]);

  const handleLoadClick = useCallback(() => {
    const trimmedResource = resource.trim();
    if (trimmedResource.length === 0) {
      return;
    }

    setActiveResource(trimmedResource);
  }, [resource]);

  const handleReconnect = useCallback(() => {
    const trimmedResource = resource.trim();
    if (trimmedResource.length === 0) {
      return;
    }

    setActiveResource(trimmedResource);
  }, [resource]);

  const handleDisconnect = useCallback(() => {
    setActiveResource(null);
  }, []);

  const { isLoading, playbackState } = playerSnapshot;

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
        onResourceChange={handleResourceChange}
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
        hasStream={playbackState.hasStream}
        hasResource={resource.trim().length > 0}
        onReconnect={handleReconnect}
        onDisconnect={handleDisconnect}
        statusMessage={playbackState.message}
      />

      <WHEPPlayer
        onSnapshotChange={setPlayerSnapshot}
        resourceUserId={activeResource}
        snapshot={playerSnapshot}
      />

      <OBSStreamingInfo user={user} />
    </div>
  );
}

export function WHEPPlayerPage({ user }: { user: User }) {
  return (
    <WHEPPlayerProvider>
      <WHEPPlayerPageContent user={user} />
    </WHEPPlayerProvider>
  );
}
