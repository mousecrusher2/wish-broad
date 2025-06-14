import { useState, useRef, useEffect } from "react";
import type { WHEPPlayerProps } from "./types";
import { useLiveStreams } from "./useLiveStreams";
import { OBSStreamingInfo } from "./OBSStreamingInfo";

export function WHEPPlayer({ user }: WHEPPlayerProps) {
  const [resource, setResource] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<
    "disconnected" | "connecting" | "connected" | "failed" | "reconnecting"
  >("disconnected");
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const isReconnectingRef = useRef<boolean>(false);
  const currentResourceRef = useRef<string>("");
  const muteTimeoutRef = useRef<number | null>(null);
  const pendingTimeoutsRef = useRef<Set<number>>(new Set());
  const healthCheckIntervalRef = useRef<number | null>(null);
  const {
    streams,
    isLoading: streamsLoading,
    error: streamsError,
    refresh,
  } = useLiveStreams(); // 接続をクリーンアップする関数
  const cleanupConnection = () => {
    stopHealthCheck(); // ヘルスチェックを停止

    // すべての保留中のタイムアウトをクリア
    pendingTimeoutsRef.current.forEach((timeoutId) => {
      clearTimeout(timeoutId);
    });
    pendingTimeoutsRef.current.clear();

    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (muteTimeoutRef.current) {
      clearTimeout(muteTimeoutRef.current);
      muteTimeoutRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setStreamUrl(null);
    setConnectionStatus("disconnected");
    isReconnectingRef.current = false;
  }; // 再接続を試行する関数（重複実行を防ぐ）
  const attemptReconnect = async (resourceValue: string) => {
    // より厳密な重複実行チェック
    if (isReconnectingRef.current) {
      return;
    } // 現在の接続状態をチェック
    const goodStates = ["connected", "connecting"];
    if (goodStates.includes(connectionStatus)) {
      return;
    }

    const maxRetries = 5;
    const baseDelay = 2000; // 2秒

    if (reconnectAttempt >= maxRetries) {
      setConnectionStatus("failed");
      setIsLoading(false);
      isReconnectingRef.current = false;
      return;
    }

    isReconnectingRef.current = true;
    setConnectionStatus("reconnecting");
    setReconnectAttempt((prev) => prev + 1);

    const delay = baseDelay * Math.pow(2, reconnectAttempt); // 指数バックオフ

    const timeoutId = window.setTimeout(() => {
      pendingTimeoutsRef.current.delete(timeoutId);
      isReconnectingRef.current = false;
      load(resourceValue, true);
    }, delay);

    reconnectTimeoutRef.current = timeoutId;
    pendingTimeoutsRef.current.add(timeoutId);
  };
  const load = async (resourceValue: string, isReconnect = false) => {
    if (!resourceValue) return;

    // 現在のリソースを記録
    currentResourceRef.current = resourceValue;

    // 再接続でない場合は、既存の接続をクリーンアップし、再接続カウンターをリセット
    if (!isReconnect) {
      cleanupConnection();
      setReconnectAttempt(0);
      isReconnectingRef.current = false;
    }

    setIsLoading(true);
    setConnectionStatus("connecting");

    try {
      const resourceUrl = new URL(`/play/${resourceValue}`, location.origin);
      const pc = new RTCPeerConnection({
        bundlePolicy: "max-bundle",
      });

      // pcRefに保存
      pcRef.current = pc; // 接続状態の監視（適切なイベントハンドリング）
      pc.addEventListener("connectionstatechange", () => {
        switch (pc.connectionState) {
          case "connected":
            setConnectionStatus("connected");
            setReconnectAttempt(0); // 成功したらカウンターリセット
            isReconnectingRef.current = false;

            // すべての保留中のタイムアウトをクリア（成功したので不要）
            pendingTimeoutsRef.current.forEach((timeoutId) => {
              clearTimeout(timeoutId);
            });
            pendingTimeoutsRef.current.clear();

            if (muteTimeoutRef.current) {
              clearTimeout(muteTimeoutRef.current);
              muteTimeoutRef.current = null;
            }
            break;
          case "failed":
            if (canAttemptReconnect()) {
              attemptReconnect(currentResourceRef.current);
            }
            break;
          case "disconnected":
            // disconnectedから一定時間後に再接続を試行
            const timeoutId = window.setTimeout(() => {
              pendingTimeoutsRef.current.delete(timeoutId);
              if (
                pc.connectionState === "disconnected" &&
                currentResourceRef.current &&
                !isReconnectingRef.current &&
                connectionStatus !== "connecting" &&
                connectionStatus !== "connected"
              ) {
                attemptReconnect(currentResourceRef.current);
              }
            }, 2000); // 2秒待つ
            pendingTimeoutsRef.current.add(timeoutId);
            break;
          case "connecting":
          case "new":
            break;
        }
      });

      // ICE接続状態の監視
      pc.addEventListener("iceconnectionstatechange", () => {
        switch (pc.iceConnectionState) {
          case "connected":
          case "completed":
            break;
          case "failed":
            if (
              currentResourceRef.current &&
              !isReconnectingRef.current &&
              connectionStatus !== "connecting"
            ) {
              attemptReconnect(currentResourceRef.current);
            }
            break;
          case "disconnected":
            // disconnectedからfailedに遷移する可能性があるため、少し待つ
            const timeoutId = window.setTimeout(() => {
              pendingTimeoutsRef.current.delete(timeoutId);
              if (
                pc.iceConnectionState === "disconnected" &&
                currentResourceRef.current &&
                !isReconnectingRef.current &&
                connectionStatus !== "connecting" &&
                connectionStatus !== "connected"
              ) {
                attemptReconnect(currentResourceRef.current);
              }
            }, 3000); // 3秒待つ
            pendingTimeoutsRef.current.add(timeoutId);
            break;
          case "checking":
          case "new":
            break;
        }
      });

      const candidatesPromise = new Promise<void>((resolve) => {
        pc.addEventListener("icegatheringstatechange", (ev) => {
          let connection = ev.target as RTCPeerConnection;
          if (!connection) {
            throw new Error("No connection found");
          }

          switch (connection.iceGatheringState) {
            case "complete":
              resolve();
              break;
          }
        });
      });
      const remoteTracksPromise = new Promise<MediaStreamTrack[]>((resolve) => {
        let tracks: MediaStreamTrack[] = [];
        pc.ontrack = (event) => {
          tracks.push(event.track);
          event.track.onended = () => {
            // トラックが終了した場合、再接続を試行
            if (
              currentResourceRef.current &&
              !isReconnectingRef.current &&
              connectionStatus !== "connecting"
            ) {
              attemptReconnect(currentResourceRef.current);
            }
          };

          event.track.onmute = () => {
            // ミュート状態のタイムアウトを設定（10秒）
            if (muteTimeoutRef.current) {
              clearTimeout(muteTimeoutRef.current);
            }
            const timeoutId = window.setTimeout(() => {
              pendingTimeoutsRef.current.delete(timeoutId);
              if (
                currentResourceRef.current &&
                event.track.muted &&
                !isReconnectingRef.current &&
                connectionStatus !== "connecting" &&
                connectionStatus !== "connected"
              ) {
                attemptReconnect(currentResourceRef.current);
              }
            }, 10000); // 10秒でタイムアウト
            muteTimeoutRef.current = timeoutId;
            pendingTimeoutsRef.current.add(timeoutId);
          };

          event.track.onunmute = () => {
            // アンミュートされた場合、タイムアウトをクリア
            if (muteTimeoutRef.current) {
              clearTimeout(muteTimeoutRef.current);
              muteTimeoutRef.current = null;
            }
          };

          // ビデオまたはオーディオのいずれか1つでも受信したら解決
          // （2トラック待ちではなく、より柔軟に対応）
          if (tracks.length >= 1) {
            resolve(tracks);
          }
        };

        // タイムアウトを設定（10秒でタイムアウト）
        setTimeout(() => {
          if (tracks.length === 0) {
            resolve(tracks);
          }
        }, 10000);
      });

      const offer = await fetch(resourceUrl, { method: "POST" });
      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp: await offer.text() })
      );
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await candidatesPromise;
      let sessionUrl = new URL(resourceUrl);
      sessionUrl.pathname = offer.headers.get("location")!;
      await fetch(sessionUrl.href, { method: "PATCH", body: answer.sdp });
      const remoteTracks = await remoteTracksPromise;

      if (remoteTracks.length === 0) {
        throw new Error("No tracks received from remote peer");
      }

      const remoteStream = new MediaStream();

      // 受信したすべてのトラックをストリームに追加
      remoteTracks.forEach((track) => {
        remoteStream.addTrack(track);
      });
      setStreamUrl("active");
      setConnectionStatus("connected");

      // 接続成功時にヘルスチェックを開始
      startHealthCheck();
      // video要素のrefを設定（複数回試行でより確実に）
      const setVideoStream = (attempts = 0) => {
        if (videoRef.current) {
          videoRef.current.srcObject = remoteStream; // video要素のイベントリスナーを追加

          videoRef.current.onstalled = () => {
            // ビデオが停止した場合、再接続を試行
            if (currentResourceRef.current) {
              setTimeout(() => {
                if (currentResourceRef.current) {
                  attemptReconnect(currentResourceRef.current);
                }
              }, 3000); // 3秒待ってから再接続
            }
          };
          videoRef.current.onwaiting = () => {
            // データ待機が長時間続く場合、再接続を検討
            const timeoutId = window.setTimeout(() => {
              pendingTimeoutsRef.current.delete(timeoutId);
              if (
                videoRef.current &&
                videoRef.current.readyState < 2 &&
                currentResourceRef.current &&
                !isReconnectingRef.current &&
                connectionStatus !== "connecting" &&
                connectionStatus !== "connected"
              ) {
                attemptReconnect(currentResourceRef.current);
              }
            }, 8000); // 8秒待機
            pendingTimeoutsRef.current.add(timeoutId);
          };

          videoRef.current.onabort = () => {
            if (
              currentResourceRef.current &&
              !isReconnectingRef.current &&
              connectionStatus !== "connecting"
            ) {
              attemptReconnect(currentResourceRef.current);
            }
          };

          videoRef.current.onemptied = () => {
            // ビデオが空になった場合（srcObjectが失われた場合など）
            if (
              currentResourceRef.current &&
              connectionStatus === "connected" &&
              !isReconnectingRef.current
            ) {
              const timeoutId = window.setTimeout(() => {
                pendingTimeoutsRef.current.delete(timeoutId);
                const goodStates = ["connecting", "connected"];
                if (
                  currentResourceRef.current &&
                  !isReconnectingRef.current &&
                  !goodStates.includes(connectionStatus)
                ) {
                  attemptReconnect(currentResourceRef.current);
                }
              }, 2000);
              pendingTimeoutsRef.current.add(timeoutId);
            }
          };
          videoRef.current.onerror = () => {
            // ビデオエラーが発生した場合も再接続を試行
            if (
              currentResourceRef.current &&
              !isReconnectingRef.current &&
              connectionStatus !== "connecting" &&
              connectionStatus !== "connected"
            ) {
              attemptReconnect(currentResourceRef.current);
            }
          };

          // 自動再生を試行
          videoRef.current.play().catch(() => {});
        } else {
          // 最大3回まで再試行
          if (attempts < 3) {
            setTimeout(() => setVideoStream(attempts + 1), 50 * (attempts + 1));
          }
        }
      };
      // 即座に試行し、失敗したら再試行
      setVideoStream();
    } catch (error) {
      setStreamUrl(null);
      if (!isReconnect) {
        alert("ストリームの読み込みに失敗しました");
        setConnectionStatus("failed");
      } else {
        // 再接続中のエラーの場合、さらに再接続を試行
        attemptReconnect(resourceValue);
      }
    } finally {
      setIsLoading(false);
    }
  };
  // 手動再接続ボタン用の関数
  const handleReconnect = () => {
    if (resource) {
      setReconnectAttempt(0);
      isReconnectingRef.current = false;
      load(resource);
    }
  }; // コンポーネントアンマウント時のクリーンアップ
  useEffect(() => {
    return () => {
      cleanupConnection();
      isReconnectingRef.current = false;
    };
  }, []);

  const handleLoadClick = async () => {
    await load(resource);
  };

  const selectedStream = streams.find(
    (stream) => stream.owner.userId === resource
  );

  // ネットワーク状態とページ可視性の監視
  useEffect(() => {
    // オンライン/オフライン状態の監視
    const handleOnline = () => {
      // オンラインになった場合、接続が切れていたら再接続を試行
      if (
        (connectionStatus === "failed" ||
          connectionStatus === "disconnected") &&
        currentResourceRef.current
      ) {
        setReconnectAttempt(0);
        isReconnectingRef.current = false;
        load(currentResourceRef.current);
      }
    };

    const handleOffline = () => {
      setConnectionStatus("disconnected");
    };

    // ページの可視性状態の監視
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        // ページが再表示された時、接続が切れていたら再接続を試行
        if (
          (connectionStatus === "failed" ||
            connectionStatus === "disconnected") &&
          currentResourceRef.current
        ) {
          setReconnectAttempt(0);
          isReconnectingRef.current = false;
          load(currentResourceRef.current);
        }
      }
    };

    // イベントリスナーを追加
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    // クリーンアップ
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [connectionStatus]);

  // 定期的な接続状態チェック
  const startHealthCheck = () => {
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
    }
    healthCheckIntervalRef.current = window.setInterval(() => {
      if (pcRef.current && currentResourceRef.current) {
        const pc = pcRef.current;
        // 接続が切断されている、または失敗している場合
        if (
          pc.connectionState === "failed" ||
          pc.connectionState === "disconnected" ||
          pc.iceConnectionState === "failed" ||
          pc.iceConnectionState === "disconnected"
        ) {
          if (
            !isReconnectingRef.current &&
            connectionStatus !== "connecting" &&
            connectionStatus !== "connected"
          ) {
            attemptReconnect(currentResourceRef.current);
          }
        }

        // ビデオ要素の状態もチェック
        if (videoRef.current) {
          const video = videoRef.current;
          if (video.srcObject) {
            const stream = video.srcObject as MediaStream;
            const tracks = stream.getTracks();

            // すべてのトラックが終了またはミュートされている場合
            const allTracksEnded = tracks.every(
              (track) => track.readyState === "ended"
            );

            if (allTracksEnded) {
              if (
                !isReconnectingRef.current &&
                connectionStatus !== "connecting" &&
                connectionStatus !== "connected"
              ) {
                attemptReconnect(currentResourceRef.current);
              }
            }
          }
        }
      }
    }, 5000); // 5秒毎にチェック
  };

  const stopHealthCheck = () => {
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
      healthCheckIntervalRef.current = null;
    }
  };

  // テスト用: 接続を意図的に切断する関数
  const handleDisconnect = () => {
    if (pcRef.current) {
      pcRef.current.close();
    }
  };

  // 再接続が可能な状態かチェックするヘルパー関数
  const canAttemptReconnect = () => {
    const goodStates = ["connecting", "connected"];
    return (
      currentResourceRef.current &&
      !isReconnectingRef.current &&
      !goodStates.includes(connectionStatus)
    );
  };

  return (
    <div className="grid">
      <h1>Basic WISH WHEP Player</h1>
      <div className="user-info">
        <p>ようこそ、{user.displayName}さん</p>
      </div>
      <div className="stream-selection">
        <label htmlFor="stream-select">配信を選択:</label>
        {streamsLoading ? (
          <p>配信リストを読み込み中...</p>
        ) : streamsError ? (
          <div>
            <p>エラー: {streamsError}</p>
            <button onClick={refresh} type="button">
              再試行
            </button>
          </div>
        ) : (
          <select
            id="stream-select"
            value={resource}
            onChange={(e) => setResource(e.target.value)}
            disabled={isLoading}
          >
            <option value="">配信を選択してください</option>{" "}
            {streams.map((stream, index) => (
              <option key={index} value={stream.owner.userId}>
                🎥 {stream.owner.displayName}
              </option>
            ))}
          </select>
        )}
        {selectedStream && (
          <div className="selected-stream-info">
            <p>
              選択中:{" "}
              <span className="stream-owner">
                {selectedStream.owner.displayName}
              </span>
              <span className="stream-text">の配信</span>
            </p>
          </div>
        )}
        {connectionStatus !== "disconnected" && (
          <div className={`connection-status ${connectionStatus}`}>
            <p>
              接続状態:
              <span className="status-text">
                {connectionStatus === "connecting" && "接続中..."}
                {connectionStatus === "connected" && "✅ 接続済み"}
                {connectionStatus === "reconnecting" &&
                  `🔄 再接続中 (${reconnectAttempt}/5)`}
                {connectionStatus === "failed" && "❌ 接続失敗"}
              </span>
            </p>{" "}
            {connectionStatus === "failed" && (
              <button
                onClick={handleReconnect}
                type="button"
                className="reconnect-button"
              >
                手動再接続
              </button>
            )}
            {connectionStatus === "connected" && (
              <button
                onClick={handleDisconnect}
                type="button"
                className="disconnect-button"
                style={{ marginLeft: "10px", backgroundColor: "#ff6b6b" }}
              >
                🔌 テスト切断
              </button>
            )}{" "}
          </div>
        )}{" "}
      </div>

      <div className="load-button-section">
        <button
          onClick={handleLoadClick}
          disabled={isLoading || !resource.trim() || streamsLoading}
        >
          {isLoading ? "読み込み中..." : "Load"}
        </button>
      </div>

      <div className="remote-media-section">
        <h2>Remote media</h2>
        <div className="video-player-container">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            controls
            muted={false}
            className="styled-video-player"
            style={{
              backgroundColor: "#000",
              display:
                streamUrl && connectionStatus === "connected"
                  ? "block"
                  : "none",
            }}
          />
          {!(streamUrl && connectionStatus === "connected") && (
            <div className="no-stream-placeholder">
              {connectionStatus === "connecting" && <p>配信に接続中...</p>}
              {connectionStatus === "reconnecting" && <p>再接続中...</p>}
              {connectionStatus === "failed" && <p>接続に失敗しました</p>}
              {connectionStatus === "disconnected" && (
                <p>配信を選択して「Load」ボタンを押してください</p>
              )}

              {/* デバッグ情報 */}
              <div
                style={{ marginTop: "1rem", fontSize: "0.8rem", color: "#888" }}
              >
                <p>接続状態: {connectionStatus}</p>
                <p>ストリームURL: {streamUrl}</p>
                <p>PCの状態: {pcRef.current?.connectionState || "未接続"}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* OBS配信設定セクション */}
      <OBSStreamingInfo user={user} />
    </div>
  );
}
