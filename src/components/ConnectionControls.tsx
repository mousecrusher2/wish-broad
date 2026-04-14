import {
  getPlaybackPhaseMessage,
  type WHEPPlaybackPhase,
  type WHEPPlaybackState,
} from "../player/whep-playback";

export function ConnectionControls({
  playbackState,
}: {
  playbackState: WHEPPlaybackState;
}) {
  const statusClasses: Record<
    WHEPPlaybackPhase,
    {
      dot: string;
      panel: string;
      text: string;
    }
  > = {
    idle: {
      dot: "bg-slate-500",
      panel: "border-white/10 bg-slate-900/70",
      text: "text-slate-200",
    },
    connected: {
      dot: "bg-emerald-400",
      panel: "border-emerald-400/20 bg-emerald-500/10",
      text: "text-emerald-100",
    },
    connecting: {
      dot: "bg-amber-400",
      panel: "border-amber-400/20 bg-amber-500/10",
      text: "text-amber-50",
    },
    reconnecting: {
      dot: "bg-amber-400",
      panel: "border-amber-400/20 bg-amber-500/10",
      text: "text-amber-50",
    },
    ended: {
      dot: "bg-slate-500",
      panel: "border-white/10 bg-slate-900/70",
      text: "text-slate-200",
    },
    error: {
      dot: "bg-rose-400",
      panel: "border-rose-400/20 bg-rose-500/10",
      text: "text-rose-100",
    },
  };

  const styles = statusClasses[playbackState.phase];
  const sectionClasses = `ml-auto w-fit max-w-full rounded-2xl border p-4 sm:p-5 ${styles.panel}`;

  return (
    <section className={sectionClasses}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span
          className={`inline-flex items-center gap-3 text-sm font-medium ${styles.text}`}
        >
          <span
            className={`inline-block size-2.5 rounded-full ${styles.dot}`}
          />
          {getPlaybackPhaseMessage(playbackState.phase)}
        </span>
      </div>
    </section>
  );
}
