import { useState } from "react";
import { useLiveToken } from "./useLiveToken";
import type { User } from "./types";

type OBSStreamingInfoProps = {
  user: User;
};

type TokenSectionProps = {
  state: ReturnType<typeof useLiveToken>["state"];
  onRetry: () => void;
  onCreateToken: () => void;
  onShowToken: () => void;
  onHideToken: () => void;
  copyStatus: "none" | "url" | "token";
  copyToClipboard: (text: string, type: "url" | "token") => Promise<void>;
};

type StreamingUrlSectionProps = {
  streamingUrl: string;
  copyStatus: "none" | "url" | "token";
  copyToClipboard: (text: string, type: "url" | "token") => Promise<void>;
};

const fieldLabelClasses =
  "mb-2 block text-sm font-semibold tracking-wide text-slate-200";
const fieldInputClasses =
  "w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-slate-100 shadow-inner shadow-black/20 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20";
const inlineFieldClasses = "flex flex-col gap-3 sm:flex-row";
const copyButtonClasses =
  "inline-flex items-center justify-center rounded-full bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-100 transition hover:bg-slate-700";
const subtleCardClasses =
  "rounded-2xl border border-white/10 bg-slate-950/30 p-5 shadow-inner shadow-black/20";
const primaryButtonClasses =
  "inline-flex items-center justify-center rounded-full bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300";
const warningButtonClasses =
  "inline-flex items-center justify-center rounded-full bg-amber-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-amber-300";
const neutralButtonClasses =
  "inline-flex items-center justify-center rounded-full border border-slate-600 bg-slate-800 px-5 py-3 text-sm font-semibold text-slate-100 transition hover:bg-slate-700";
const dangerButtonClasses =
  "inline-flex items-center justify-center rounded-full bg-rose-500 px-5 py-3 text-sm font-semibold text-white transition hover:bg-rose-400";

function StreamingUrlSection({
  streamingUrl,
  copyStatus,
  copyToClipboard,
}: StreamingUrlSectionProps) {
  return (
    <div className="space-y-2">
      <label htmlFor="streaming-url" className={fieldLabelClasses}>
        配信URL (Server):
      </label>
      <div className={inlineFieldClasses}>
        <input
          id="streaming-url"
          type="text"
          value={streamingUrl}
          readOnly
          className={fieldInputClasses}
        />
        <button
          onClick={() => {
            void copyToClipboard(streamingUrl, "url");
          }}
          className={copyButtonClasses}
          type="button"
        >
          {copyStatus === "url" ? "✅ コピー済み" : "📋 コピー"}
        </button>
      </div>
    </div>
  );
}

function TokenSection({
  state,
  onRetry,
  onCreateToken,
  onShowToken,
  onHideToken,
  copyStatus,
  copyToClipboard,
}: TokenSectionProps) {
  const token =
    state.status === "available" && state.token ? state.token : undefined;

  return (
    <div className="space-y-2">
      <div className={subtleCardClasses}>
        <label className={fieldLabelClasses}>
          Bearerトークン (Stream Key):
        </label>
        {state.status === "loading" ? (
          <p className="text-sm text-amber-200">読み込み中...</p>
        ) : state.status === "error" ? (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-rose-200">❌ {state.message}</p>
            <button
              onClick={onRetry}
              type="button"
              className={dangerButtonClasses}
            >
              再試行
            </button>
          </div>
        ) : state.status === "available" ? (
          <div className="flex flex-col gap-4">
            <p className="text-sm font-medium text-emerald-200">
              ✅ Bearerトークンが発行済みです
            </p>
            {token ? (
              <div className="flex flex-col gap-3">
                <div className={inlineFieldClasses}>
                  <input
                    type="text"
                    value={token}
                    readOnly
                    className={fieldInputClasses}
                  />
                  <button
                    onClick={() => {
                      void copyToClipboard(token, "token");
                    }}
                    className={copyButtonClasses}
                    type="button"
                  >
                    {copyStatus === "token" ? "✅ コピー済み" : "📋 コピー"}
                  </button>
                </div>
                <button
                  onClick={onHideToken}
                  className={neutralButtonClasses}
                  type="button"
                >
                  🙈 非表示
                </button>
              </div>
            ) : (
              <button
                onClick={onShowToken}
                className={neutralButtonClasses}
                type="button"
              >
                👁️ トークンを表示
              </button>
            )}
            <button
              onClick={onCreateToken}
              className={warningButtonClasses}
              type="button"
            >
              🔄 新しいトークンを発行
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm font-medium text-amber-100">
              ⚠️ Bearerトークンが発行されていません
            </p>
            <button
              onClick={onCreateToken}
              className={primaryButtonClasses}
              type="button"
            >
              🔑 Bearerトークンを発行
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function OBSInstructions() {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/30 p-5 shadow-inner shadow-black/20">
      <h4 className="text-lg font-semibold text-white">📖 OBS設定方法</h4>
      <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-7 text-slate-300">
        <li>OBSを開き、「設定」→「配信」を選択</li>
        <li>サービス: 「WHIP」を選択</li>
        <li>サーバー: 上記の配信URLをコピー</li>
        <li>Bearerトークン: 上記の配信キーをコピー</li>
        <li>「OK」をクリックして設定完了</li>
      </ol>
    </div>
  );
}

export function OBSStreamingInfo({ user }: OBSStreamingInfoProps) {
  const { state, fetchTokenStatus, createToken } = useLiveToken();
  const [, setShowToken] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"none" | "url" | "token">(
    "none",
  );
  const [showOBSSettings, setShowOBSSettings] = useState(false);

  const streamingUrl = `${window.location.origin}/ingest/${user.userId}`;

  const copyToClipboard = async (text: string, type: "url" | "token") => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(type);
      setTimeout(() => {
        setCopyStatus("none");
      }, 2000);
    } catch (err) {
      console.error("Failed to copy to clipboard:", err);
      alert("クリップボードへのコピーに失敗しました");
    }
  };

  const handleCreateToken = async () => {
    await createToken();
    setShowToken(true);
  };

  return (
    <section className="rounded-4xl border border-white/10 bg-slate-900/70 p-6 shadow-xl shadow-black/20 backdrop-blur">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm font-medium tracking-[0.3em] text-cyan-300/80 uppercase">
            Broadcast Setup
          </p>
          <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
            OBS配信設定
          </h2>
        </div>
        <button
          onClick={() => {
            setShowOBSSettings(!showOBSSettings);
          }}
          className="inline-flex items-center justify-center rounded-full bg-linear-to-r from-cyan-400 via-blue-500 to-emerald-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:brightness-110"
          type="button"
        >
          {showOBSSettings ? "📺 OBS配信設定を隠す" : "📺 OBS配信設定を表示"}
        </button>
      </div>

      {showOBSSettings && (
        <div className="mt-5 space-y-6 rounded-[1.75rem] border border-cyan-400/10 bg-[linear-gradient(145deg,rgba(15,23,42,0.96),rgba(8,47,73,0.92))] p-6 shadow-inner shadow-black/30">
          <h3 className="text-xl font-semibold text-white">📺 OBS配信設定</h3>
          <StreamingUrlSection
            streamingUrl={streamingUrl}
            copyStatus={copyStatus}
            copyToClipboard={copyToClipboard}
          />
          <TokenSection
            state={state}
            onRetry={() => {
              void fetchTokenStatus();
            }}
            onCreateToken={() => {
              void handleCreateToken();
            }}
            onShowToken={() => {
              setShowToken(true);
            }}
            onHideToken={() => {
              setShowToken(false);
            }}
            copyStatus={copyStatus}
            copyToClipboard={copyToClipboard}
          />
          <OBSInstructions />
        </div>
      )}
    </section>
  );
}
