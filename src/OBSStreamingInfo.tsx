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

function StreamingUrlSection({
  streamingUrl,
  copyStatus,
  copyToClipboard,
}: StreamingUrlSectionProps) {
  return (
    <div className="streaming-url-section">
      <label htmlFor="streaming-url">配信URL (Server):</label>
      <div className="input-with-button">
        <input
          id="streaming-url"
          type="text"
          value={streamingUrl}
          readOnly
          className="streaming-url-input"
        />
        <button
          onClick={() => copyToClipboard(streamingUrl, "url")}
          className="copy-button"
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
  return (
    <div className="streaming-token-section">
      <div className="token-status">
        <label>Bearerトークン (Stream Key):</label>
        {state.status === "loading" ? (
          <p className="loading">読み込み中...</p>
        ) : state.status === "error" ? (
          <div className="error-section">
            <p className="error">❌ {state.message}</p>
            <button onClick={onRetry} type="button" className="retry-button">
              再試行
            </button>
          </div>
        ) : state.status === "available" ? (
          <div className="token-available">
            <p className="status-text">✅ Bearerトークンが発行済みです</p>
            {state.token ? (
              <div className="token-display">
                <div className="input-with-button">
                  <input
                    type="text"
                    value={state.token}
                    readOnly
                    className="token-input"
                  />
                  <button
                    onClick={() => copyToClipboard(state.token!, "token")}
                    className="copy-button"
                    type="button"
                  >
                    {copyStatus === "token" ? "✅ コピー済み" : "📋 コピー"}
                  </button>
                </div>
                <button
                  onClick={onHideToken}
                  className="hide-token-button"
                  type="button"
                >
                  🙈 非表示
                </button>
              </div>
            ) : (
              <button
                onClick={onShowToken}
                className="show-token-button"
                type="button"
              >
                👁️ トークンを表示
              </button>
            )}
            <button
              onClick={onCreateToken}
              className="regenerate-button"
              type="button"
            >
              🔄 新しいトークンを発行
            </button>
          </div>
        ) : (
          <div className="token-not-available">
            <p className="status-text">⚠️ Bearerトークンが発行されていません</p>
            <button
              onClick={onCreateToken}
              className="create-token-button"
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
    <div className="obs-instructions">
      <h4>📖 OBS設定方法</h4>
      <ol>
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
      setTimeout(() => setCopyStatus("none"), 2000);
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
    <div className="obs-streaming-info">
      <div className="obs-toggle-section">
        <button
          onClick={() => setShowOBSSettings(!showOBSSettings)}
          className="obs-toggle-button"
          type="button"
        >
          {showOBSSettings ? "📺 OBS配信設定を隠す" : "📺 OBS配信設定を表示"}
        </button>
      </div>

      {showOBSSettings && (
        <div className="obs-settings-content">
          <h3>📺 OBS配信設定</h3>
          <StreamingUrlSection
            streamingUrl={streamingUrl}
            copyStatus={copyStatus}
            copyToClipboard={copyToClipboard}
          />
          <TokenSection
            state={state}
            onRetry={fetchTokenStatus}
            onCreateToken={handleCreateToken}
            onShowToken={() => setShowToken(true)}
            onHideToken={() => setShowToken(false)}
            copyStatus={copyStatus}
            copyToClipboard={copyToClipboard}
          />
          <OBSInstructions />
        </div>
      )}
    </div>
  );
}
