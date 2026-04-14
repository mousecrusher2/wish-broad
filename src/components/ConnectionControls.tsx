import {
  getPlaybackPhaseMessage,
  type WHEPPlaybackState,
} from "../player/whep-playback";

export function ConnectionControls({
  playbackState,
}: Readonly<{
  playbackState: WHEPPlaybackState;
}>) {
  const panelStyle = {
    idle: "border-white/10 bg-slate-900/70",
    connected: "border-emerald-400/20 bg-emerald-500/10",
    connecting: "border-amber-400/20 bg-amber-500/10",
    reconnecting: "border-amber-400/20 bg-amber-500/10",
    ended: "border-white/10 bg-slate-900/70",
    error: "border-rose-400/20 bg-rose-500/10",
  }[playbackState.phase];

  const textStyle = {
    idle: "text-slate-200",
    connected: "text-emerald-100",
    connecting: "text-amber-50",
    reconnecting: "text-amber-50",
    ended: "text-slate-200",
    error: "text-rose-100",
  }[playbackState.phase];

  const dotStyle = {
    idle: "bg-slate-500",
    connected: "bg-emerald-400",
    connecting: "bg-amber-400",
    reconnecting: "bg-amber-400",
    ended: "bg-slate-500",
    error: "bg-rose-400",
  }[playbackState.phase];

  return (
    <section
      className={`ml-auto w-fit max-w-full rounded-2xl border p-4 sm:p-5 ${panelStyle}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span
          className={`inline-flex items-center gap-3 text-sm font-medium ${textStyle}`}
        >
          <span className={`inline-block size-2.5 rounded-full ${dotStyle}`} />
          {getPlaybackPhaseMessage(playbackState.phase)}
        </span>
      </div>
    </section>
  );
}
