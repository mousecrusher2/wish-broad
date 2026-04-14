import {
  useCallback,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import {
  WHEPPlaybackController,
  type WHEPPlaybackControllerSnapshot,
} from "./player/WHEPPlaybackController";
import { getPlaybackPlaceholderText } from "./player/whep-playback";

export type WHEPPlayerSnapshot = WHEPPlaybackControllerSnapshot;

function VideoPlaceholder({ message }: { message: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm leading-7 text-slate-400">
      {message}
    </div>
  );
}

export function WHEPPlayer({
  onSnapshotChange,
  resourceUserId,
  snapshot,
}: {
  onSnapshotChange: (snapshot: WHEPPlaybackControllerSnapshot) => void;
  resourceUserId: string | null;
  snapshot: WHEPPlayerSnapshot;
}) {
  const [controller] = useState(() => new WHEPPlaybackController());
  const disposeTokenRef = useRef(0);
  const handleSnapshotChange = useEffectEvent(
    (nextSnapshot: WHEPPlaybackControllerSnapshot) => {
      onSnapshotChange(nextSnapshot);
    },
  );

  useEffect(() => {
    const subscriber = (nextSnapshot: WHEPPlaybackControllerSnapshot) => {
      handleSnapshotChange(nextSnapshot);
    };
    controller.setSnapshotSubscriber(subscriber);

    return () => {
      controller.unsetSnapshotSubscriber(subscriber);
    };
  }, [controller]);

  useEffect(() => {
    disposeTokenRef.current += 1;
    const disposeToken = disposeTokenRef.current;

    return () => {
      queueMicrotask(() => {
        if (disposeTokenRef.current === disposeToken) {
          controller.dispose();
        }
      });
    };
  }, [controller]);

  useEffect(() => {
    if (resourceUserId === null) {
      controller.disconnect();
      return;
    }

    const trimmedResourceUserId = resourceUserId.trim();
    if (trimmedResourceUserId.length === 0) {
      return;
    }

    controller.load(trimmedResourceUserId);
  }, [controller,  resourceUserId]);

  const videoRef = useCallback(
    (videoElement: HTMLVideoElement | null) => {
      controller.attachVideoElement(videoElement);
    },
    [controller],
  );

  return (
    <div className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-black/70 shadow-2xl shadow-black/30">
      <video
        ref={videoRef}
        className={`aspect-video w-full bg-black object-contain ${snapshot.playbackState.hasStream ? "opacity-100" : "opacity-0"}`}
        controls={snapshot.playbackState.hasStream}
        autoPlay
        playsInline
      />
      {!snapshot.playbackState.hasStream && (
        <VideoPlaceholder
          message={getPlaybackPlaceholderText(snapshot.playbackState)}
        />
      )}
    </div>
  );
}
