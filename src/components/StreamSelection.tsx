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
  const loadButton = (
    <button
      onClick={onLoadClick}
      disabled={isLoading || !resource.trim() || streamsLoading}
      type="button"
      className="inline-flex items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
    >
      {isLoading ? "読み込み中..." : "Load"}
    </button>
  );

  const streamCards =
    streams.length > 0 ? (
      streams.map((stream) => {
        const isSelected = resource === stream.owner.userId;

        return (
          <label
            key={stream.owner.userId}
            className={`flex cursor-pointer items-start gap-3 rounded-2xl border px-4 py-3 transition ${
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
              className="mt-1 size-4 accent-cyan-400"
            />
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-white">
                {stream.owner.displayName}
              </span>
            </span>
          </label>
        );
      })
    ) : (
      <div className="rounded-2xl border border-dashed border-white/15 bg-slate-950/30 px-5 py-6 text-sm text-slate-400">
        現在利用可能な配信はありません
      </div>
    );

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
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
        {
          <div className="max-w-full min-w-0 flex-none">
            {<ConnectionControls playbackState={playbackState} />}
          </div>
        }
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
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-slate-300">
            利用可能な配信一覧
          </p>
          {streamsLoading && (
            <span className="text-sm text-slate-400">配信一覧を更新中...</span>
          )}
        </div>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1 space-y-3">{streamCards}</div>
          <div className="shrink-0">{loadButton}</div>
        </div>
      </div>

      {resource && (
        <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3 text-sm text-cyan-100">
          選択中:{" "}
          <span className="font-semibold text-white">
            {streams.find((s) => s.owner.userId === resource)?.owner
              .displayName || "不明な配信"}
          </span>
          <span className="text-cyan-100/80"> の配信</span>
        </div>
      )}
    </section>
  );
}
