import { useState } from "react";
import { OBSStreamingInfo } from "./OBSStreamingInfo";
import { StreamSelection } from "./components/StreamSelection";
import { WHEPPlayer } from "./WHEPPlayer";
import {
  createDefaultSnapshot,
  type WHEPPlaybackControllerSnapshot,
} from "./player/WHEPPlaybackController";
import { revalidateLiveStreams, useCurrentUser, useLiveStreams } from "./api";
import { buttonClasses, surfaceClasses } from "./components/styles";

type PlayerSelection = {
  resourceUserId: string;
  loadSequence: number;
} | null;

function CurrentUserGreeting() {
  const currentUserState = useCurrentUser();

  if (currentUserState.status === "loading") {
    return (
      <p className="truncate text-sm text-cyan-50/80">
        ユーザー情報を確認中...
      </p>
    );
  }

  if (currentUserState.status === "error") {
    return (
      <p className="text-sm text-amber-200">ユーザー情報を取得できません</p>
    );
  }

  return (
    <p className="truncate text-sm text-cyan-50/90">
      ようこそ、
      <span className="font-semibold text-white">
        {currentUserState.user.displayName}
      </span>{" "}
      さん
    </p>
  );
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
    "error" in liveStreamsState ? liveStreamsState.error : null;

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
  const [playerSelection, setPlayerSelection] = useState<PlayerSelection>(null);
  const [isObsSettingsOpen, setIsObsSettingsOpen] = useState(false);
  const [playerSnapshot, setPlayerSnapshot] =
    useState<WHEPPlaybackControllerSnapshot>(createDefaultSnapshot);

  const handleResourceChange = (nextResource: string) => {
    setResource(nextResource);
  };

  const handleLoadClick = () => {
    const trimmedResource = resource.trim();
    setPlayerSelection((currentSelection) => ({
      resourceUserId: trimmedResource,
      // Loading the same stream again creates a fresh controller and session.
      loadSequence: currentSelection ? currentSelection.loadSequence + 1 : 1,
    }));
  };

  const handlePlayerSnapshotChange = (
    nextSnapshot: WHEPPlaybackControllerSnapshot,
  ) => {
    if (
      playerSnapshot.playbackState.phase !== "ended" &&
      nextSnapshot.playbackState.phase === "ended"
    ) {
      // The player is one of the targeted reconciliation points. Refresh the
      // cheap list after playback proves the selected live ended.
      void revalidateLiveStreams();
    }

    setPlayerSnapshot(nextSnapshot);
  };

  const { isLoading, playbackState } = playerSnapshot;
  const activePlayer = playerSelection;
  const playerMountId = activePlayer?.loadSequence ?? 0;

  return (
    <div className="min-h-screen">
      <header className="border-b border-cyan-200/15 bg-cyan-950/90 backdrop-blur-sm">
        <div className="flex flex-col gap-2 px-4 py-2.5 md:flex-row md:items-center md:justify-between md:px-6 xl:px-8">
          <h1 className="text-xl font-semibold tracking-tight text-white md:text-2xl">
            ANGOU BROADCAST
          </h1>
          <nav className="flex flex-wrap items-center gap-3">
            <div className="min-h-5 w-full min-w-0 md:w-auto md:max-w-64">
              <CurrentUserGreeting />
            </div>
            <button
              type="button"
              aria-expanded={isObsSettingsOpen}
              aria-haspopup="dialog"
              onClick={() => {
                setIsObsSettingsOpen(true);
              }}
              className={buttonClasses("primary", "sm")}
            >
              📺 OBS配信設定
            </button>
            <form method="POST" action="/logout">
              <button type="submit" className={buttonClasses("danger", "sm")}>
                ログアウト
              </button>
            </form>
          </nav>
        </div>
      </header>

      <div className="flex flex-col gap-6 px-4 py-6 md:px-6 xl:px-8">
        <OBSStreamingInfo
          isOpen={isObsSettingsOpen}
          onClose={() => {
            setIsObsSettingsOpen(false);
          }}
        />

        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          <section className={`p-4 lg:w-80 lg:flex-none ${surfaceClasses}`}>
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
              resourceUserId={activePlayer?.resourceUserId ?? null}
              snapshot={playerSnapshot}
              key={playerMountId}
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
