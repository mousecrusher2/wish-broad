import { useState } from "react";
import { useLiveToken } from "./useLiveToken";
import type { User } from "./types";

interface OBSStreamingInfoProps {
  user: User;
}

export function OBSStreamingInfo({ user }: OBSStreamingInfoProps) {
  const { hasToken, token, isLoading, error, fetchTokenStatus, createToken } =
    useLiveToken();
  const [showToken, setShowToken] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"none" | "url" | "token">(
    "none"
  );
  const [showOBSSettings, setShowOBSSettings] = useState(false);

  // OBS配信用URL
  const streamingUrl = `${window.location.origin}/ingest/${user.userId}`;

  // クリップボードにコピー
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
    if (!error) {
      setShowToken(true);
    }
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

          <div className="streaming-token-section">
            <div className="token-status">
              <label>配信キー (Stream Key):</label>
              {isLoading ? (
                <p className="loading">読み込み中...</p>
              ) : error ? (
                <div className="error-section">
                  <p className="error">❌ {error}</p>
                  <button
                    onClick={fetchTokenStatus}
                    type="button"
                    className="retry-button"
                  >
                    再試行
                  </button>
                </div>
              ) : hasToken ? (
                <div className="token-available">
                  <p className="status-text">✅ 配信キーが発行済みです</p>
                  {token && showToken ? (
                    <div className="token-display">
                      <div className="input-with-button">
                        <input
                          type="text"
                          value={token}
                          readOnly
                          className="token-input"
                        />
                        <button
                          onClick={() => copyToClipboard(token, "token")}
                          className="copy-button"
                          type="button"
                        >
                          {copyStatus === "token"
                            ? "✅ コピー済み"
                            : "📋 コピー"}
                        </button>
                      </div>
                      <button
                        onClick={() => setShowToken(false)}
                        className="hide-token-button"
                        type="button"
                      >
                        🙈 非表示
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowToken(true)}
                      className="show-token-button"
                      type="button"
                    >
                      👁️ キーを表示
                    </button>
                  )}
                  <button
                    onClick={handleCreateToken}
                    className="regenerate-button"
                    type="button"
                    disabled={isLoading}
                  >
                    🔄 新しいキーを発行
                  </button>
                </div>
              ) : (
                <div className="token-not-available">
                  <p className="status-text">⚠️ 配信キーが発行されていません</p>
                  <button
                    onClick={handleCreateToken}
                    className="create-token-button"
                    type="button"
                    disabled={isLoading}
                  >
                    🔑 配信キーを発行
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="obs-instructions">
            <h4>📖 OBS設定方法</h4>
            <ol>
              <li>OBSを開き、「設定」→「配信」を選択</li>
              <li>サービス: 「カスタム」を選択</li>
              <li>サーバー: 上記の配信URLをコピー</li>
              <li>ストリームキー: 上記の配信キーをコピー</li>
              <li>「OK」をクリックして設定完了</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
