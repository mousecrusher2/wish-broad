import type { WHEPConnectionStatus } from "../player/WHEPClient";
import type { WHEPPlaybackPhase } from "../player/whep-playback";

interface ConnectionControlsProps {
  connectionPhase: WHEPPlaybackPhase;
  connectionStatus: WHEPConnectionStatus;
  hasStream: boolean;
  statusMessage: string | null;
  embedded?: boolean;
}

function assertUnreachableStatus(status: never): never {
  void status;
  throw new Error("Unexpected connection status");
}

export function ConnectionControls({
  connectionPhase,
  connectionStatus,
  hasStream,
  statusMessage,
  embedded = false,
}: ConnectionControlsProps) {
  const statusClasses: Record<
    WHEPPlaybackPhase,
    {
      dot: string;
      panel: string;
      text: string;
    }
  > = {
    idle: {
      dot: "bg-slate-500",
      panel: "border-white/10 bg-slate-900/70",
      text: "text-slate-200",
    },
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
    reconnecting: {
      dot: "bg-amber-400",
      panel: "border-amber-400/20 bg-amber-500/10",
      text: "text-amber-50",
    },
    ended: {
      dot: "bg-slate-500",
      panel: "border-white/10 bg-slate-900/70",
      text: "text-slate-200",
    },
    error: {
      dot: "bg-rose-400",
      panel: "border-rose-400/20 bg-rose-500/10",
      text: "text-rose-100",
    },
  };

  const getStatusText = () => {
    if (statusMessage) {
      return statusMessage;
    }

    switch (connectionStatus) {
      case "disconnected":
        return "未接続";
      case "connecting":
        return "接続中...";
      case "connected":
        return connectionPhase === "connected" && !hasStream
          ? "接続済み（映像待機中）"
          : "接続済み";
      case "failed":
        return "接続失敗";
    }

    return assertUnreachableStatus(connectionStatus);
  };
  const styles = statusClasses[connectionPhase];
  const sectionClasses = embedded
    ? `ml-auto w-fit max-w-full rounded-2xl border p-4 sm:p-5 ${styles.panel}`
    : `rounded-4xl border p-4 shadow-xl shadow-black/20 backdrop-blur sm:p-5 ${styles.panel}`;

  return (
    <section className={sectionClasses}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <span
          className={`inline-flex items-center gap-3 text-sm font-medium ${styles.text}`}
        >
          <span
            className={`inline-block size-2.5 rounded-full ${styles.dot}`}
          />
          {getStatusText()}
        </span>
      </div>
    </section>
  );
}
