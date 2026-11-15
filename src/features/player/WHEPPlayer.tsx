import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  WHEPPlaybackController,
  type WHEPPlaybackControllerSnapshot,
} from "../../player/controller";
import { getPlaybackPlaceholderText } from "./messages";

type WHEPPlayerSnapshot = WHEPPlaybackControllerSnapshot;

function VideoPlaceholder({ message }: Readonly<{ message: string }>) {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm leading-6 text-slate-400">
      {message}
    </div>
  );
}

/**
 * 1 人の配信者の再生を所有するプレーヤー。コントローラーはマウントごとに 1 つ作るため、
 * 配信者を変えるときや同じ配信を読み込み直すときは `key` を変えて再マウントすること。
 *
 * @throws {Error} 再マウントせずに `resourceUserId` が変わった場合。
 */
export function WHEPPlayer({
  onSnapshotChange,
  resourceUserId,
  snapshot,
}: Readonly<{
  onSnapshotChange: (snapshot: WHEPPlaybackControllerSnapshot) => void;
  resourceUserId: string | null;
  snapshot: WHEPPlayerSnapshot;
}>) {
  const [{ controller, initialResourceUserId }] = useState(() => ({
    controller: new WHEPPlaybackController(),
    initialResourceUserId: resourceUserId,
  }));
  const disposeTokenRef = useRef(0);

  if (initialResourceUserId !== resourceUserId) {
    throw new Error("WHEPPlayer resource changed without remounting");
  }

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
      // 開発環境では React Strict Mode によりエフェクトのクリーンアップと再セットアップが
      // 連続して実行される場合がある。前のクリーンアップがセッションを破棄する前に
      // 後続のセットアップがコントローラーを引き継げるよう、破棄処理を遅延させる。
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

    void controller.load(trimmedResourceUserId);
  }, [controller, resourceUserId]);

  const videoRef = (videoElement: HTMLVideoElement | null) => {
    void controller.attachVideoElement(videoElement);
  };

  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-black/80 shadow-xl shadow-black/25">
      {/* oxlint-disable jsx-a11y/media-has-caption */}
      <video
        ref={videoRef}
        aria-label="ライブ配信プレイヤー"
        className={`aspect-video w-full bg-black object-contain ${snapshot.playbackState.hasStream ? "opacity-100" : "opacity-0"}`}
        controls={snapshot.playbackState.hasStream}
        autoPlay
        playsInline
      />
      {/* oxlint-enable jsx-a11y/media-has-caption */}
      {!snapshot.playbackState.hasStream && (
        <VideoPlaceholder
          message={getPlaybackPlaceholderText(snapshot.playbackState)}
        />
      )}
    </div>
  );
}
