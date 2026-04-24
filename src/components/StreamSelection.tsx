import type { Live } from "../types";
import { ConnectionControls } from "./ConnectionControls";
import { WHEPPlaybackState } from "../player/whep-playback";

export function StreamSelection({
  resource,
  onResourceChange,
  streams,
  isLoading,
  error,
  onRefresh,
  onLoadClick,
  streamsLoading,
  playbackState,
}: Readonly<{
  resource: string;
  onResourceChange: (resource: string) => void;
  streams: Live[];
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onLoadClick: () => void;
  streamsLoading: boolean;
  playbackState: WHEPPlaybackState;
}>) {
  const selectedStreamName =
    streams.find((stream) => stream.owner.userId === resource)?.owner
      .displayName ?? null;

  return (
    <section className="space-y-4">
      <div className="space-y-3">
        <div className="min-w-0">
          <p className="text-sm font-medium tracking-[0.3em] text-cyan-300/80 uppercase">
            Stream Browser
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
            配信選択
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            視聴したい配信を選び、接続を開始します。
          </p>
        </div>

        <div className="min-w-0">
          <ConnectionControls playbackState={playbackState} />
        </div>
      </div>

      {error && (
        <div className="flex flex-col gap-3 rounded-2xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm text-rose-200 sm:flex-row sm:items-center sm:justify-between">
          <span>エラー: {error}</span>
          <button
            onClick={onRefresh}
            type="button"
            className="inline-flex items-center justify-center rounded-full border border-rose-300/30 bg-rose-400/20 px-4 py-2 text-sm font-semibold text-rose-100 transition hover:bg-rose-400/30"
          >
            再試行
          </button>
        </div>
      )}

      <div className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-medium text-slate-300">
              利用可能な配信一覧
            </p>
            <p className="truncate text-xs text-slate-400">
              {resource ? (
                <>
                  選択中:{" "}
                  <span className="font-medium text-cyan-100">
                    {selectedStreamName ?? "不明な配信"}
                  </span>
                </>
              ) : (
                "配信を選択してください"
              )}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            <button
              onClick={onRefresh}
              disabled={streamsLoading}
              type="button"
              className="inline-flex items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10 px-5 py-3 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-400/20 active:translate-y-px active:scale-[0.98] active:border-cyan-300/60 active:bg-cyan-300/25 disabled:cursor-not-allowed disabled:border-slate-600 disabled:bg-slate-700 disabled:text-slate-400"
            >
              Reload
            </button>
          </div>
        </div>

        <div className="h-72 rounded-xl border border-white/10 bg-slate-950/30">
          <div className="h-full [overflow-y:overlay] px-2 py-2 [scrollbar-width:thin] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/15 hover:[&::-webkit-scrollbar-thumb]:bg-white/25 [&::-webkit-scrollbar-track]:bg-transparent">
            <div className="space-y-2">
              {streams.length > 0 ? (
                streams.map((stream) => {
                  const isSelected = resource === stream.owner.userId;

                  return (
                    <label
                      key={stream.owner.userId}
                      className={`flex cursor-pointer items-center gap-2 rounded-md border p-1 transition ${
                        isSelected
                          ? "border-cyan-400/60 bg-cyan-400/10 shadow-lg shadow-cyan-950/30"
                          : "border-white/10 bg-slate-950/40 hover:border-cyan-400/40 hover:bg-slate-950/70"
                      }`}
                    >
                      <input
                        type="radio"
                        name="stream"
                        value={stream.owner.userId}
                        checked={isSelected}
                        onChange={(e) => {
                          onResourceChange(e.target.value);
                        }}
                        className="size-4 accent-cyan-400"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-white">
                          {stream.owner.displayName}
                        </span>
                      </span>
                    </label>
                  );
                })
              ) : (
                <div className="flex h-full items-center justify-center px-5 py-6 text-center text-sm text-slate-400">
                  現在利用可能な配信はありません
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3">
          <button
            onClick={onLoadClick}
            disabled={isLoading || !resource.trim() || streamsLoading}
            type="button"
            className="inline-flex shrink-0 items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 active:translate-y-px active:scale-[0.98] disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {isLoading ? "読み込み中..." : "Load"}
          </button>
        </div>
      </div>
    </section>
  );
}
