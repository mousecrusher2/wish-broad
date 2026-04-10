import { useState, useEffect, useCallback, useRef } from "react";
import type { WHEPPlayerProps } from "./types";
import { useLiveStreams } from "./useLiveStreams";
import { OBSStreamingInfo } from "./OBSStreamingInfo";
import { ConnectionControls } from "./components/ConnectionControls";
import { StreamSelection } from "./components/StreamSelection";
import { VideoPlayer } from "./components/VideoPlayer";
import { WHEPClient, type WHEPConnectionStatus } from "./player/WHEPClient";

export function WHEPPlayer({ user }: WHEPPlayerProps) {
  const [resource, setResource] = useState("");
  const [connectionStatus, setConnectionStatus] =
    useState<WHEPConnectionStatus>("disconnected");
  const [isLoading, setIsLoading] = useState(false);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerRef = useRef<WHEPClient | null>(null);

  // ライブストリーム取得
  const {
    streams,
    isLoading: streamsLoading,
    error: streamsError,
    refresh,
  } = useLiveStreams();

  useEffect(() => {
    if (!videoRef.current) {
      return;
    }

    const player = new WHEPClient(videoRef.current, {
      onStatusChange: (status) => {
        setConnectionStatus(status);
      },
      onStreamChange: (hasStream) => {
        setStreamUrl(hasStream ? "active" : null);
      },
    });

    playerRef.current = player;

    return () => {
      void player.dispose();
      playerRef.current = null;
    };
  }, []);

  const load = useCallback(async (resourceToLoad: string) => {
    const player = playerRef.current;
    if (!player || !resourceToLoad.trim()) {
      return;
    }

    setIsLoading(true);

    try {
      await player.connect(resourceToLoad);
    } catch (error) {
      console.error("Failed to load stream:", error);
      alert("ストリームの読み込みに失敗しました");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const handleReconnect = useCallback(() => {
    void load(resource);
  }, [resource, load]);

  const handleDisconnect = useCallback(() => {
    const player = playerRef.current;
    if (!player) {
      return;
    }

    void player.disconnect();
  }, []);

  const handleLoadClick = useCallback(() => {
    void load(resource);
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
        connectionStatus={connectionStatus}
        hasResource={!!resource.trim()}
        onReconnect={handleReconnect}
        onDisconnect={handleDisconnect}
      />
      <VideoPlayer ref={videoRef} streamUrl={streamUrl} />
      <OBSStreamingInfo user={user} />
    </div>
  );
}
