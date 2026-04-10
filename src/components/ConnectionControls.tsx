import type { WHEPConnectionStatus } from "../player/WHEPClient";

interface ConnectionControlsProps {
  connectionStatus: WHEPConnectionStatus;
  hasResource: boolean;
  onReconnect: () => void;
  onDisconnect: () => void;
}

export function ConnectionControls({
  connectionStatus,
  hasResource,
  onReconnect,
  onDisconnect,
}: ConnectionControlsProps) {
  const statusClasses: Record<
    WHEPConnectionStatus,
    {
      dot: string;
      panel: string;
      text: string;
    }
  > = {
    connected: {
      dot: "bg-emerald-400",
      panel: "border-emerald-400/20 bg-emerald-500/10",
      text: "text-emerald-100",
    },
    connecting: {
      dot: "bg-amber-400",
      panel: "border-amber-400/20 bg-amber-500/10",
      text: "text-amber-50",
    },
    disconnected: {
      dot: "bg-slate-500",
      panel: "border-white/10 bg-slate-900/70",
      text: "text-slate-200",
    },
    failed: {
      dot: "bg-rose-400",
      panel: "border-rose-400/20 bg-rose-500/10",
      text: "text-rose-100",
    },
  };

  const getStatusText = () => {
    switch (connectionStatus) {
      case "connecting":
        return "接続中...";
      case "connected":
        return "接続済み";
      case "failed":
        return "接続失敗";
      default:
        return "未接続";
    }
  };
  const styles = statusClasses[connectionStatus];

  return (
    <section
      className={`rounded-4xl border p-4 shadow-xl shadow-black/20 backdrop-blur sm:p-5 ${styles.panel}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span
          className={`inline-flex items-center gap-3 text-sm font-medium ${styles.text}`}
        >
          <span
            className={`inline-block size-2.5 rounded-full ${styles.dot}`}
          />
          {getStatusText()}
        </span>
        {hasResource &&
          (connectionStatus === "failed" ||
            connectionStatus === "disconnected") && (
            <button
              onClick={onReconnect}
              type="button"
              className="inline-flex items-center justify-center rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-400/20"
            >
              手動再接続
            </button>
          )}
        {connectionStatus === "connected" &&
          window.location.hostname === "localhost" && (
            <button
              onClick={onDisconnect}
              type="button"
              className="inline-flex items-center justify-center rounded-full border border-rose-400/30 bg-rose-500/90 px-4 py-2 text-sm font-semibold text-white transition hover:bg-rose-400"
            >
              🔌 テスト切断
            </button>
          )}
      </div>
    </section>
  );
}
