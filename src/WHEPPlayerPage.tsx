import { Suspense, useCallback, useState } from "react";
import { OBSStreamingInfo } from "./OBSStreamingInfo";
import { StreamSelection } from "./components/StreamSelection";
import { WHEPPlayer } from "./WHEPPlayer";
import {
  createDefaultSnapshot,
  type WHEPPlaybackControllerSnapshot,
} from "./player/WHEPPlaybackController";
import {
  revalidateLiveStreams,
  useLiveStreams,
  useSuspenseCurrentUser,
} from "./api";

const OBS_SETTINGS_POPOVER_ID = "obs-settings-popover";

function CurrentUserGreeting() {
  const currentUserResult = useSuspenseCurrentUser();

  if (currentUserResult.isErr()) {
    return (
      <p className="text-sm text-amber-100">ユーザー情報を取得できません</p>
    );
  }

  return (
    <p className="text-sm text-cyan-50/90">
      ようこそ、
      <span className="font-semibold">
        {currentUserResult.value.displayName}
      </span>{" "}
      さん
    </p>
  );
}

function CurrentUserGreetingFallback() {
  return <p className="text-sm text-cyan-50/75">ユーザー情報を確認中...</p>;
}

function StreamSelectionPanel({
  isLoading,
  onLoadClick,
  onResourceChange,
  playbackState,
  resource,
}: Readonly<{
  isLoading: boolean;
  onLoadClick: () => void;
  onResourceChange: (resource: string) => void;
  playbackState: WHEPPlaybackControllerSnapshot["playbackState"];
  resource: string;
}>) {
  const { refresh, ...liveStreamsState } = useLiveStreams();
  const streams =
    liveStreamsState.status === "ready" ||
    liveStreamsState.status === "refreshing"
      ? liveStreamsState.streams
      : [];
  const streamsLoading =
    liveStreamsState.status === "loading" ||
    liveStreamsState.status === "refreshing" ||
    liveStreamsState.status === "retrying";
  const streamsError =
    liveStreamsState.status === "error" ||
    liveStreamsState.status === "retrying"
      ? liveStreamsState.error
      : null;

  return (
    <StreamSelection
      resource={resource}
      onResourceChange={onResourceChange}
      streams={streams}
      isLoading={isLoading}
      error={streamsError}
      onRefresh={refresh}
      onLoadClick={onLoadClick}
      streamsLoading={streamsLoading}
      playbackState={playbackState}
    />
  );
}

function WHEPPlayerPageContent() {
  const [resource, setResource] = useState("");
  const [activeResource, setActiveResource] = useState<string | null>(null);
  // Loading the same stream again should still create a fresh controller and
  // WHEP session, so explicit loads advance this remount key.
  const [loadSequence, setLoadSequence] = useState(0);
  const [playerSnapshot, setPlayerSnapshot] =
    useState<WHEPPlaybackControllerSnapshot>(createDefaultSnapshot);

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
        // The player is one of the targeted reconciliation points. Refresh the
        // cheap list after playback proves the selected live ended.
        void revalidateLiveStreams();
      }

      setPlayerSnapshot(nextSnapshot);
    },
    [playerSnapshot.playbackState.phase],
  );

  const { isLoading, playbackState } = playerSnapshot;

  return (
    <div className="min-h-screen">
      <header className="border-b border-cyan-200/20 bg-cyan-950/92 shadow-[0_10px_20px_-16px_rgba(8,145,178,0.38)] backdrop-blur-sm">
        <div className="flex flex-col gap-2 px-4 py-3 md:flex-row md:items-center md:justify-between md:px-6 xl:px-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-white md:text-3xl">
              ANGOU BROADCAST
            </h1>
          </div>
          <nav className="flex flex-wrap items-center gap-3">
            <Suspense fallback={<CurrentUserGreetingFallback />}>
              <CurrentUserGreeting />
            </Suspense>
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

      <div className="flex flex-col gap-6 px-4 py-6 md:px-6 xl:px-8">
        <OBSStreamingInfo popoverId={OBS_SETTINGS_POPOVER_ID} />

        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <section className="rounded-4xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-black/20 backdrop-blur lg:w-[20rem] lg:flex-none">
            <StreamSelectionPanel
              resource={resource}
              onResourceChange={handleResourceChange}
              isLoading={isLoading}
              onLoadClick={handleLoadClick}
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

export function WHEPPlayerPage() {
  return <WHEPPlayerPageContent />;
}
