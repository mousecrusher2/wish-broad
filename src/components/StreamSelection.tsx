import type { Live } from "../types";

interface StreamSelectionProps {
  resource: string;
  setResource: (resource: string) => void;
  streams: Live[];
  isLoading: boolean;
  error: string | null;
  onRefresh: () => void;
  onLoadClick: () => void;
  streamsLoading: boolean;
}

export function StreamSelection({
  resource,
  setResource,
  streams,
  isLoading,
  error,
  onRefresh,
  onLoadClick,
  streamsLoading,
}: StreamSelectionProps) {
  return (
    <div className="controls">
      <div className="stream-selection">
        <h2>配信選択</h2>
        {error && (
          <div style={{ color: "red", marginBottom: "1rem" }}>
            エラー: {error}
            <button onClick={onRefresh} style={{ marginLeft: "10px" }}>
              再試行
            </button>
          </div>
        )}
        {streams.length > 0 ? (
          <div>
            <p>利用可能な配信一覧:</p>
            {streams.map((stream) => (
              <label
                key={stream.owner.userId}
                style={{
                  display: "block",
                  margin: "5px 0",
                  cursor: "pointer",
                }}
              >
                <input
                  type="radio"
                  name="stream"
                  value={stream.owner.userId}
                  checked={resource === stream.owner.userId}
                  onChange={(e) => {
                    setResource(e.target.value);
                  }}
                  style={{ marginRight: "8px" }}
                />
                {stream.owner.displayName}の配信
              </label>
            ))}
          </div>
        ) : (
          <p>現在利用可能な配信はありません</p>
        )}

        {resource && (
          <div className="selected-stream-info">
            <p>
              選択中:{" "}
              <span className="stream-owner">
                {streams.find((s) => s.owner.userId === resource)?.owner
                  .displayName || resource}
              </span>
              <span className="stream-text">の配信</span>
            </p>
          </div>
        )}
      </div>

      <div className="load-button-section">
        <button
          onClick={onLoadClick}
          disabled={isLoading || !resource.trim() || streamsLoading}
        >
          {isLoading ? "読み込み中..." : "Load"}
        </button>
      </div>
    </div>
  );
}
