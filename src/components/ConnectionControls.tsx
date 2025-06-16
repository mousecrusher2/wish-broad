import type { ConnectionStatus } from "../hooks/useWebRTCConnection";

interface ConnectionControlsProps {
  connectionStatus: ConnectionStatus;
  reconnectAttempt: number;
  hasResource: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}

export function ConnectionControls({
  connectionStatus,
  reconnectAttempt,
  hasResource,
  onReconnect,
  onDisconnect,
}: ConnectionControlsProps) {
  const getStatusText = () => {
    switch (connectionStatus) {
      case "connecting":
        return "接続中...";
      case "connected":
        return "接続済み";
      case "failed":
        return "接続失敗";
      case "reconnecting":
        return `再接続中... (試行回数: ${reconnectAttempt})`;
      default:
        return "未接続";
    }
  };

  const getStatusColor = () => {
    switch (connectionStatus) {
      case "connected":
        return "#4CAF50";
      case "connecting":
      case "reconnecting":
        return "#FF9800";
      case "failed":
        return "#F44336";
      default:
        return "#9E9E9E";
    }
  };

  return (
    <div className={`connection-status ${connectionStatus}`}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
        <span className="status-text">
          <span
            style={{
              display: "inline-block",
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: getStatusColor(),
              marginRight: "8px",
            }}
          />
          {getStatusText()}
        </span>{" "}
        {hasResource &&
          (connectionStatus === "failed" ||
            connectionStatus === "disconnected") && (
            <button
              onClick={onReconnect}
              type="button"
              className="reconnect-button"
            >
              手動再接続
            </button>
          )}
        {connectionStatus === "connected" &&
          window.location.hostname === "localhost" && (
            <button
              onClick={onDisconnect}
              type="button"
              className="disconnect-button"
              style={{ marginLeft: "10px", backgroundColor: "#ff6b6b" }}
            >
              🔌 テスト切断
            </button>
          )}
      </div>
    </div>
  );
}
