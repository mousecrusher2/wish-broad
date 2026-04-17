import { useCallback, useState } from "react";
import type { User } from "./types";
import { OBSStreamingInfo } from "./OBSStreamingInfo";
import { StreamSelection } from "./components/StreamSelection";
import { WHEPPlayer } from "./WHEPPlayer";
import { createDefaultSnapshot, type WHEPPlaybackControllerSnapshot } from "./player/WHEPPlaybackController";
import { useLiveStreams } from "./useLiveStreams";

const OBS_SETTINGS_POPOVER_ID = "obs-settings-popover";

function WHEPPlayerPageContent({ user }: Readonly<{ user: User }>) {
  const [resource, setResource] = useState("");
  const [activeResource, setActiveResource] = useState<string | null>(null);
  const [loadSequence, setLoadSequence] = useState(0);
  const [playerSnapshot, setPlayerSnapshot] =
    useState<WHEPPlaybackControllerSnapshot>(createDefaultSnapshot);

  const {
    streams,
    isLoading: streamsLoading,
    error: streamsError,
    refresh,
  } = useLiveStreams();

  const handleResourceChange = useCallback(
    (nextResource: string) => {
      setResource(nextResource);
    },
    [setResource],
  );

  const handleLoadClick = useCallback(() => {
    const trimmedResource = resource.trim();
    if (trimmedResource.length === 0) {
      return;
    }

    setActiveResource(trimmedResource);
    setLoadSequence((currentValue) => currentValue + 1);
  }, [resource]);

  const handlePlayerSnapshotChange = useCallback(
    (nextSnapshot: WHEPPlaybackControllerSnapshot) => {
      if (
        playerSnapshot.playbackState.phase !== "ended" &&
        nextSnapshot.playbackState.phase === "ended"
      ) {
        refresh();
      }

      setPlayerSnapshot(nextSnapshot);
    },
    [playerSnapshot.playbackState.phase, refresh],
  );

  const { isLoading, playbackState } = playerSnapshot;

  return (
    <div className="min-h-screen">
      <header className="border-b border-cyan-200/20 bg-cyan-950/92 shadow-[0_10px_20px_-16px_rgba(8,145,178,0.38)] backdrop-blur-sm">
        <div className="flex flex-col gap-2 px-4 py-3 sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">
              ANGOU BROADCAST
            </h1>
          </div>
          <nav className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-cyan-50/90">
              ようこそ、
              <span className="font-semibold">{user.displayName}</span> さん
            </p>
            <button
              type="button"
              popoverTarget={OBS_SETTINGS_POPOVER_ID}
              popoverTargetAction="toggle"
              className="inline-flex items-center justify-center rounded-full bg-cyan-300 px-4 py-2 text-sm font-semibold whitespace-nowrap text-slate-950 shadow-[0_14px_26px_-18px_rgba(34,211,238,0.95)] transition hover:bg-cyan-200"
            >
              📺 OBS配信設定
            </button>
            <form method="POST" action="/logout">
              <button
                type="submit"
                className="inline-flex items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/90 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-400"
              >
                ログアウト
              </button>
            </form>
          </nav>
        </div>
      </header>

      <div className="flex flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <OBSStreamingInfo user={user} popoverId={OBS_SETTINGS_POPOVER_ID} />

        <div className="flex flex-col gap-6 min-[75rem]:flex-row min-[75rem]:items-start">
          <section className="rounded-4xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-black/20 backdrop-blur min-[75rem]:w-[24rem] min-[75rem]:flex-none">
            <StreamSelection
              resource={resource}
              onResourceChange={handleResourceChange}
              streams={streams}
              isLoading={isLoading}
              error={streamsError}
              onRefresh={refresh}
              onLoadClick={handleLoadClick}
              streamsLoading={streamsLoading}
              playbackState={playbackState}
            />
          </section>

          <div className="min-w-0 flex-1">
            <WHEPPlayer
              onSnapshotChange={handlePlayerSnapshotChange}
              resourceUserId={activeResource}
              snapshot={playerSnapshot}
              key={loadSequence}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function WHEPPlayerPage({ user }: Readonly<{ user: User }>) {
  return <WHEPPlayerPageContent user={user} />;
}
