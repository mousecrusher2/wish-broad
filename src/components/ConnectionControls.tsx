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
    idle: "border-white/10 bg-white/5",
    connected: "border-emerald-400/30 bg-emerald-500/10",
    connecting: "border-amber-400/30 bg-amber-500/10",
    reconnecting: "border-amber-400/30 bg-amber-500/10",
    ended: "border-white/10 bg-white/5",
    error: "border-rose-400/30 bg-rose-500/10",
  }[playbackState.phase];

  const textStyle = {
    idle: "text-slate-300",
    connected: "text-emerald-100",
    connecting: "text-amber-100",
    reconnecting: "text-amber-100",
    ended: "text-slate-300",
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
      className={`flex min-h-10 max-w-full min-w-0 items-center gap-2.5 rounded-lg border px-3.5 py-2 ${panelStyle}`}
    >
      <span
        className={`inline-block size-2.5 shrink-0 rounded-full ${dotStyle}`}
      />
      <span
        className={`min-h-5 truncate text-[15px] leading-5 font-semibold ${textStyle}`}
      >
        {message}
      </span>
    </div>
  );
}
