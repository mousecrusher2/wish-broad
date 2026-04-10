import { forwardRef } from "react";

interface VideoPlayerProps {
  streamUrl: string | null;
}

export const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(
  ({ streamUrl }, ref) => {
    return (
      <section className="rounded-4xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-black/20 backdrop-blur">
        <div className="mb-4">
          <p className="text-sm font-medium tracking-[0.3em] text-cyan-300/80 uppercase">
            Playback
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
            配信映像
          </h2>
        </div>
        <div className="relative overflow-hidden rounded-[1.75rem] border border-white/10 bg-black/70 shadow-2xl shadow-black/30">
          <div className="absolute inset-x-0 top-0 z-10 h-1 bg-linear-to-r from-cyan-400 via-blue-500 to-emerald-400" />
          {streamUrl ? (
            <video
              ref={ref}
              className="aspect-video w-full bg-black object-contain"
              controls
              autoPlay
              muted
              playsInline
            />
          ) : (
            <div className="flex aspect-video items-center justify-center px-6 text-center text-sm leading-7 text-slate-400">
              配信を選択して「Load」ボタンを押してください
            </div>
          )}
        </div>
      </section>
    );
  },
);
