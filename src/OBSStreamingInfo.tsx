import { useState } from "react";
import { useCurrentUser, useLiveToken } from "./api";

type LiveTokenState = ReturnType<typeof useLiveToken>["state"];
type CopyStatus = "none" | "url" | "token";

const fieldLabelClasses =
  "mb-2 block text-sm font-semibold tracking-wide text-slate-200";
const fieldInputClasses =
  "w-full rounded-2xl border border-white/10 bg-slate-950/70 px-4 py-3 text-sm text-slate-100 shadow-inner shadow-black/20 outline-none transition focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/20";
const inlineFieldClasses = "flex flex-col gap-3 sm:flex-row";
const copyButtonClasses =
  "inline-flex items-center justify-center whitespace-nowrap rounded-full bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-100 transition hover:bg-slate-700";
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
  copyStatus,
  copyToClipboard,
}: Readonly<{
  copyStatus: CopyStatus;
  copyToClipboard: (
    text: string,
    type: Exclude<CopyStatus, "none">,
  ) => Promise<void>;
}>) {
  const currentUserState = useCurrentUser();
  const streamingUrl =
    currentUserState.status === "ready"
      ? `${window.location.origin}/ingest/${currentUserState.user.userId}`
      : null;
  let placeholder = "取得できません";
  if (currentUserState.status === "loading") {
    placeholder = "読み込み中...";
  } else if (currentUserState.status === "error") {
    placeholder = currentUserState.error;
  }

  return (
    <div className="space-y-2">
      <label htmlFor="streaming-url" className={fieldLabelClasses}>
        配信URL (Server):
      </label>
      <div className={inlineFieldClasses}>
        <input
          id="streaming-url"
          type="text"
          value={streamingUrl ?? ""}
          placeholder={placeholder}
          readOnly
          className={fieldInputClasses}
        />
        <button
          onClick={() => {
            if (streamingUrl) {
              void copyToClipboard(streamingUrl, "url");
            }
          }}
          className={`${copyButtonClasses} disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400`}
          disabled={!streamingUrl}
          type="button"
        >
          {copyStatus === "url" ? "✅ コピー済み" : "📋 コピー"}
        </button>
      </div>
    </div>
  );
}

function LoadingTokenState() {
  return <p className="text-sm text-amber-200">読み込み中...</p>;
}

function ErrorTokenState({
  message,
  onRetry,
}: Readonly<{
  message: string;
  onRetry: () => void;
}>) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-rose-200">❌ {message}</p>
      <button onClick={onRetry} type="button" className={dangerButtonClasses}>
        再試行
      </button>
    </div>
  );
}

function EmptyTokenState({
  onCreateToken,
}: Readonly<{ onCreateToken: () => void }>) {
  return (
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
  );
}

function VisibleTokenField({
  token,
  copyStatus,
  copyToClipboard,
  onHideToken,
}: Readonly<{
  token: string;
  copyStatus: CopyStatus;
  copyToClipboard: (
    text: string,
    type: Exclude<CopyStatus, "none">,
  ) => Promise<void>;
  onHideToken: () => void;
}>) {
  return (
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
  );
}

function AvailableTokenState({
  token,
  showToken,
  onCreateToken,
  onShowToken,
  onHideToken,
  copyStatus,
  copyToClipboard,
}: Readonly<{
  token: string | null;
  showToken: boolean;
  onCreateToken: () => void;
  onShowToken: () => void;
  onHideToken: () => void;
  copyStatus: CopyStatus;
  copyToClipboard: (
    text: string,
    type: Exclude<CopyStatus, "none">,
  ) => Promise<void>;
}>) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm font-medium text-emerald-200">
        ✅ Bearerトークンが発行済みです
      </p>
      {token && showToken && (
        <VisibleTokenField
          token={token}
          copyStatus={copyStatus}
          copyToClipboard={copyToClipboard}
          onHideToken={onHideToken}
        />
      )}
      {token && !showToken && (
        <button
          onClick={onShowToken}
          className={neutralButtonClasses}
          type="button"
        >
          👁️ トークンを表示
        </button>
      )}
      {!token && (
        <p className="text-sm leading-6 text-slate-300">
          既存のトークンは再表示できません。必要な場合は新しいトークンを発行してください。
        </p>
      )}
      <button
        onClick={onCreateToken}
        className={warningButtonClasses}
        type="button"
      >
        🔄 新しいトークンを発行
      </button>
    </div>
  );
}

function TokenStateContent({
  state,
  onCreateToken,
  showToken,
  onShowToken,
  onHideToken,
  copyStatus,
  copyToClipboard,
}: Readonly<{
  state: LiveTokenState;
  onCreateToken: () => void;
  showToken: boolean;
  onShowToken: () => void;
  onHideToken: () => void;
  copyStatus: CopyStatus;
  copyToClipboard: (
    text: string,
    type: Exclude<CopyStatus, "none">,
  ) => Promise<void>;
}>) {
  switch (state.status) {
    case "loading":
      return <LoadingTokenState />;
    case "available":
      return (
        <AvailableTokenState
          token={state.token}
          showToken={showToken}
          onCreateToken={onCreateToken}
          onShowToken={onShowToken}
          onHideToken={onHideToken}
          copyStatus={copyStatus}
          copyToClipboard={copyToClipboard}
        />
      );
    case "none":
      return <EmptyTokenState onCreateToken={onCreateToken} />;
  }
}

function TokenSection({
  state,
  error,
  showToken,
  onRetry,
  onCreateToken,
  onShowToken,
  onHideToken,
  copyStatus,
  copyToClipboard,
}: Readonly<{
  state: LiveTokenState;
  error: string | null;
  showToken: boolean;
  onRetry: () => void;
  onCreateToken: () => void;
  onShowToken: () => void;
  onHideToken: () => void;
  copyStatus: CopyStatus;
  copyToClipboard: (
    text: string,
    type: Exclude<CopyStatus, "none">,
  ) => Promise<void>;
}>) {
  return (
    <div className="space-y-2">
      <div className={subtleCardClasses}>
        <label className={fieldLabelClasses}>
          Bearerトークン (Stream Key):
        </label>
        {error ? (
          <ErrorTokenState message={error} onRetry={onRetry} />
        ) : (
          <TokenStateContent
            state={state}
            showToken={showToken}
            onCreateToken={onCreateToken}
            onShowToken={onShowToken}
            onHideToken={onHideToken}
            copyStatus={copyStatus}
            copyToClipboard={copyToClipboard}
          />
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

export function OBSStreamingInfo({
  popoverId,
}: Readonly<{
  popoverId: string;
}>) {
  const { state, error, fetchTokenStatus, createToken } = useLiveToken();
  const [showToken, setShowToken] = useState(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("none");

  const copyToClipboard = async (text: string, type: "url" | "token") => {
    await navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopyStatus(type);
        setTimeout(() => {
          setCopyStatus("none");
        }, 2000);
      })
      .catch((error: Error) => {
        console.error("Failed to copy to clipboard:", error);
        alert("クリップボードへのコピーに失敗しました");
      });
  };

  const handleCreateToken = async () => {
    const createResult = await createToken();
    if (createResult.isOk()) {
      setShowToken(true);
    }
  };

  return (
    <section
      id={popoverId}
      popover="auto"
      className="obs-settings-popover fixed top-1/2 right-auto left-1/2 z-50 m-0 max-h-[calc(100vh-1.5rem)] w-195 max-w-[calc(100vw-1.5rem)] -translate-x-1/2 -translate-y-1/2 overflow-visible rounded-[1.75rem] border-0 bg-transparent p-0 text-inherit shadow-2xl shadow-black/45 backdrop:bg-slate-50/30 backdrop:backdrop-blur-[20px] backdrop:backdrop-saturate-145 max-[827.98px]:inset-0 max-[827.98px]:max-h-screen max-[827.98px]:w-screen max-[827.98px]:max-w-screen max-[827.98px]:translate-none max-[827.98px]:rounded-none [&:popover-open]:block [@media(max-height:819.98px)]:inset-0 [@media(max-height:819.98px)]:max-h-screen [@media(max-height:819.98px)]:w-screen [@media(max-height:819.98px)]:max-w-screen [@media(max-height:819.98px)]:translate-none [@media(max-height:819.98px)]:rounded-none"
    >
      <div className="max-h-[calc(100vh-1.5rem)] overflow-auto rounded-[1.75rem] border border-white/15 bg-[rgb(30_41_59/0.86)] p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.16)] [backdrop-filter:blur(34px)_saturate(140%)] max-[827.98px]:max-h-screen max-[827.98px]:min-h-screen max-[827.98px]:rounded-none [@media(max-height:819.98px)]:max-h-screen [@media(max-height:819.98px)]:min-h-screen [@media(max-height:819.98px)]:rounded-none">
        <div className="space-y-6 [@media(max-height:819.98px)]:mx-auto [@media(max-height:819.98px)]:max-w-195">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-medium tracking-[0.3em] text-cyan-300/80 uppercase">
                Broadcast Setup
              </p>
              <h2 className="mt-2 text-2xl font-semibold tracking-tight text-white">
                OBS配信設定
              </h2>
            </div>
            <button
              type="button"
              popoverTarget={popoverId}
              popoverTargetAction="hide"
              className="inline-flex shrink-0 items-center justify-center rounded-full border border-cyan-300/30 bg-cyan-400/20 px-4 py-2 text-sm font-semibold whitespace-nowrap text-cyan-50 transition hover:bg-cyan-400/30"
            >
              📺 OBS配信設定を閉じる
            </button>
          </div>
          <StreamingUrlSection
            copyStatus={copyStatus}
            copyToClipboard={copyToClipboard}
          />
          <TokenSection
            state={state}
            error={error}
            showToken={showToken}
            onRetry={() => {
              void fetchTokenStatus();
              setShowToken(false);
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
      </div>
    </section>
  );
}
