import {
  getPlaybackPhaseMessage,
  type WHEPPlaybackState,
} from "../player/whep-playback";

export function ConnectionControls({
  playbackState,
}: Readonly<{
  playbackState: WHEPPlaybackState;
}>) {
  const message = getPlaybackPhaseMessage(playbackState.phase);

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
    <div
      className={`flex min-w-0 max-w-full items-center gap-3 rounded-2xl border px-4 py-3 ${panelStyle}`}
    >
      <span className={`inline-block size-3 shrink-0 rounded-full ${dotStyle}`} />
      <span className={`min-h-5 truncate text-sm leading-5 font-semibold ${textStyle}`}>
        {message ?? "\u00A0"}
      </span>
    </div>
  );
}
