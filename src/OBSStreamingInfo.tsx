import { useEffect, useId, useRef, useState } from "react";
import { useCurrentUser, useLiveToken } from "./api";
import {
  buttonClasses,
  fieldLabelClasses,
  headingClasses,
  inputClasses,
  insetClasses,
} from "./components/styles";

type LiveTokenState = ReturnType<typeof useLiveToken>["state"];
type CopyStatus = "url" | "token" | null;

const inlineFieldClasses = "flex flex-col gap-3 sm:flex-row";
const copyButtonClasses = buttonClasses("secondary");
const actionRowClasses = "flex flex-wrap gap-3";

function StreamingUrlSection({
  copyStatus,
  copyToClipboard,
}: Readonly<{
  copyStatus: CopyStatus;
  copyToClipboard: (
    text: string,
    type: Exclude<CopyStatus, null>,
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
    <div>
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
          className={inputClasses}
        />
        <button
          onClick={() => {
            if (streamingUrl) {
              void copyToClipboard(streamingUrl, "url");
            }
          }}
          className={copyButtonClasses}
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
  return <p className="text-sm text-slate-400">読み込み中...</p>;
}

function ErrorTokenState({
  message,
  onRetry,
}: Readonly<{
  message: string;
  onRetry: () => void;
}>) {
  return (
    <div className="flex flex-col items-start gap-3">
      <p className="text-sm leading-6 text-rose-200">❌ {message}</p>
      <button
        onClick={onRetry}
        type="button"
        className={buttonClasses("danger")}
      >
        再試行
      </button>
    </div>
  );
}

function EmptyTokenState({
  onCreateToken,
}: Readonly<{ onCreateToken: () => void }>) {
  return (
    <div className="flex flex-col items-start gap-4">
      <p className="text-sm font-medium text-amber-200">
        ⚠️ Bearerトークンが発行されていません
      </p>
      <button
        onClick={onCreateToken}
        className={buttonClasses("primary")}
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
}: Readonly<{
  token: string;
  copyStatus: CopyStatus;
  copyToClipboard: (
    text: string,
    type: Exclude<CopyStatus, null>,
  ) => Promise<void>;
}>) {
  return (
    <div className={inlineFieldClasses}>
      <input
        aria-label="Bearerトークン"
        type="text"
        value={token}
        readOnly
        className={inputClasses}
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
    type: Exclude<CopyStatus, null>,
  ) => Promise<void>;
}>) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm font-medium text-emerald-300">
        ✅ Bearerトークンが発行済みです
      </p>
      {token && showToken && (
        <VisibleTokenField
          token={token}
          copyStatus={copyStatus}
          copyToClipboard={copyToClipboard}
        />
      )}
      {!token && (
        <p className="text-sm leading-6 text-slate-300">
          既存のトークンは再表示できません。必要な場合は新しいトークンを発行してください。
        </p>
      )}
      <div className={actionRowClasses}>
        {token && showToken && (
          <button
            onClick={onHideToken}
            className={buttonClasses("secondary")}
            type="button"
          >
            🙈 非表示
          </button>
        )}
        {token && !showToken && (
          <button
            onClick={onShowToken}
            className={buttonClasses("secondary")}
            type="button"
          >
            👁️ トークンを表示
          </button>
        )}
        <button
          onClick={onCreateToken}
          className={buttonClasses("warning")}
          type="button"
        >
          🔄 新しいトークンを発行
        </button>
      </div>
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
    type: Exclude<CopyStatus, null>,
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
    type: Exclude<CopyStatus, null>,
  ) => Promise<void>;
}>) {
  return (
    <div className={`p-5 ${insetClasses}`}>
      <p className={fieldLabelClasses}>Bearerトークン (Stream Key):</p>
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
  );
}

function OBSInstructions() {
  return (
    <div className={`p-5 ${insetClasses}`}>
      <h3 className="text-base font-semibold text-white">📖 OBS設定方法</h3>
      <ol className="mt-3 list-decimal space-y-1.5 pl-5 text-sm leading-6 text-slate-300 marker:text-slate-400">
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
  isOpen,
  onClose,
}: Readonly<{
  isOpen: boolean;
  onClose: () => void;
}>) {
  const { state, error, fetchTokenStatus, createToken } = useLiveToken();
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [showToken, setShowToken] = useState(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }

    if (isOpen && !dialog.open) {
      dialog.showModal();
      return;
    }

    if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  const copyToClipboard = async (text: string, type: "url" | "token") => {
    await navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopyStatus(type);
        setTimeout(() => {
          setCopyStatus(null);
        }, 2000);
      })
      .catch((clipboardError: Error) => {
        console.error("Failed to copy to clipboard:", clipboardError);
        alert("クリップボードへのコピーに失敗しました");
      });
  };

  const handleCreateToken = async () => {
    if (await createToken()) {
      setShowToken(true);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      closedby="any"
      onClose={onClose}
      className="fixed top-1/2 right-auto left-1/2 z-50 m-0 max-h-[calc(100dvh-2rem)] w-2xl max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-visible rounded-2xl border-0 bg-transparent p-0 text-inherit shadow-2xl shadow-black/60 backdrop:bg-slate-950/70 backdrop:backdrop-blur-sm"
    >
      <div className="max-h-[calc(100dvh-2rem)] overflow-auto rounded-2xl border border-white/15 bg-slate-900 p-6 sm:p-8">
        <div className="flex flex-col gap-6">
          <div className="flex items-center justify-between gap-4">
            <h2 id={titleId} className={headingClasses}>
              OBS配信設定
            </h2>
            <button
              type="button"
              aria-label="OBS配信設定を閉じる"
              onClick={onClose}
              className={`shrink-0 ${buttonClasses("secondary", "icon")}`}
            >
              <svg aria-hidden="true" className="size-4" viewBox="0 0 16 16">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  fill="none"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeWidth="2"
                />
              </svg>
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
    </dialog>
  );
}
