import type { Live } from "../types";
import { ConnectionControls } from "./ConnectionControls";
import { WHEPPlaybackState } from "../player/whep-playback";
import {
  buttonClasses,
  headingClasses,
  insetClasses,
  mutedTextClasses,
  radioClasses,
} from "./styles";

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
    <section className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <div className="min-w-0">
          <h2 className={headingClasses}>配信選択</h2>
          <p className={`mt-2 ${mutedTextClasses}`}>
            視聴したい配信を選び、接続を開始します。
          </p>
        </div>

        <ConnectionControls playbackState={playbackState} />
      </div>

      {error && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-rose-400/30 bg-rose-500/10 p-4 text-sm leading-6 text-rose-200">
          <span className="text-pretty">エラー: {error}</span>
          <button
            onClick={onRefresh}
            type="button"
            className={buttonClasses("danger", "sm")}
          >
            再試行
          </button>
        </div>
      )}

      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <p className="text-sm font-semibold text-slate-200">
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
          <button
            onClick={onRefresh}
            disabled={streamsLoading}
            type="button"
            className={`shrink-0 ${buttonClasses("secondary", "sm")}`}
          >
            Reload
          </button>
        </div>

        <div className={`h-72 overflow-hidden ${insetClasses}`}>
          {streams.length > 0 ? (
            <div className="h-full [scrollbar-width:thin] space-y-2 overflow-y-auto p-2 [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-white/15 hover:[&::-webkit-scrollbar-thumb]:bg-white/25 [&::-webkit-scrollbar-track]:bg-transparent">
              {streams.map((stream) => {
                const isSelected = resource === stream.owner.userId;

                return (
                  <label
                    key={stream.owner.userId}
                    aria-label={`${stream.owner.displayName}の配信を選択`}
                    className={`flex min-h-10 cursor-pointer items-center gap-3 rounded-md border px-3 py-2 transition ${
                      isSelected
                        ? "border-cyan-400/70 bg-cyan-400/10"
                        : "border-white/10 bg-white/5 hover:border-white/20 hover:bg-white/10"
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
                      className={radioClasses}
                    />
                    <span className="min-w-0 text-[15px] leading-5 font-medium break-words text-slate-100">
                      {stream.owner.displayName}
                    </span>
                  </label>
                );
              })}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center px-5 text-center text-sm text-slate-400">
              現在利用可能な配信はありません
            </div>
          )}
        </div>

        <button
          onClick={onLoadClick}
          disabled={isLoading || !resource.trim() || streamsLoading}
          type="button"
          className={`w-full ${buttonClasses("primary")}`}
        >
          {isLoading ? "読み込み中..." : "Load"}
        </button>
      </div>
    </section>
  );
}
