import { useCallback, useRef, useEffect } from "react";
import type { ConnectionStatus } from "./useWebRTCConnection";

export function useWebRTCLoad(
  connectionStatus: ConnectionStatus,
  setIsLoading: (loading: boolean) => void,
  setConnectionStatus: (status: ConnectionStatus) => void,
  setStreamUrl: (url: string | null) => void,
  pcRef: React.RefObject<RTCPeerConnection | null>,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  isReconnectingRef: React.RefObject<boolean>,
  currentResourceRef: React.RefObject<string>,
  setReconnectAttempt: React.Dispatch<React.SetStateAction<number>>,
  pendingTimeoutsRef: React.RefObject<Set<number>>,
  muteTimeoutRef: React.RefObject<number | null>,
  cleanupConnection: () => void,
  attemptReconnect: (
    resource: string,
    loadFn: (resource: string, isReconnect?: boolean) => Promise<void>,
  ) => Promise<void>,
  startHealthCheck: (attemptReconnectFn: (resource: string) => void) => void,
  setupConnectionEventListeners: (
    pc: RTCPeerConnection,
    onConnectionChange?: () => void,
  ) => void,
) {
  // load関数への参照を保持するref（循環依存を避けるため）
  const loadFnRef = useRef<
    (resourceValue: string, isReconnect?: boolean) => Promise<void>
  >(async () => {});

  const load = useCallback(
    async (resourceValue: string, isReconnect = false) => {
      if (!resourceValue) return;

      // 現在のリソースを記録
      currentResourceRef.current = resourceValue;

      // 再接続でない場合は、既存の接続をクリーンアップし、再接続カウンターをリセット
      if (!isReconnect) {
        cleanupConnection();
        setReconnectAttempt(0);
        if (isReconnectingRef.current) {
          isReconnectingRef.current = false;
        }
      }

      setIsLoading(true);
      setConnectionStatus("connecting");

      try {
        const resourceUrl = new URL(`/play/${resourceValue}`, location.origin);
        const pc = new RTCPeerConnection({
          bundlePolicy: "max-bundle",
        });

        // pcRefに保存
        pcRef.current = pc;

        // 接続イベントリスナーを設定
        const connectionChangeHandler = () => {
          // 再接続の条件チェック
          if (
            (pc.connectionState === "failed" ||
              pc.connectionState === "disconnected") &&
            currentResourceRef.current &&
            !isReconnectingRef.current &&
            connectionStatus !== "connecting" &&
            connectionStatus !== "connected"
          ) {
            attemptReconnect(currentResourceRef.current, loadFnRef.current);
          }
        };
        setupConnectionEventListeners(pc, connectionChangeHandler);

        // ICE gathering完了を待つ

        const candidatesPromise = new Promise<void>((resolve) => {
          pc.addEventListener("icegatheringstatechange", (ev) => {
            const connection = ev.target as RTCPeerConnection;
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

        const remoteTracksPromise = new Promise<MediaStreamTrack[]>(
          (resolve) => {
            const tracks: MediaStreamTrack[] = [];
            pc.ontrack = (event) => {
              tracks.push(event.track);
              event.track.onended = () => {
                // トラックが終了した場合、再接続を試行
                if (
                  currentResourceRef.current &&
                  !isReconnectingRef.current &&
                  connectionStatus !== "connecting"
                ) {
                  attemptReconnect(
                    currentResourceRef.current,
                    loadFnRef.current,
                  );
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
                    attemptReconnect(
                      currentResourceRef.current,
                      loadFnRef.current,
                    );
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
          },
        );

        const offer = await fetch(resourceUrl, { method: "POST" });
        await pc.setRemoteDescription(
          new RTCSessionDescription({
            type: "offer",
            sdp: await offer.text(),
          }),
        );
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await candidatesPromise;
        const sessionUrl = new URL(resourceUrl);
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
        startHealthCheck((resource: string) =>
          attemptReconnect(resource, loadFnRef.current),
        );

        // video要素のrefを設定（複数回試行でより確実に）
        const setVideoStream = (attempts = 0) => {
          if (videoRef.current) {
            videoRef.current.srcObject = remoteStream;

            // video要素のイベントリスナーを追加
            videoRef.current.onstalled = () => {
              // ビデオが停止した場合、再接続を試行
              if (currentResourceRef.current) {
                setTimeout(() => {
                  if (currentResourceRef.current) {
                    attemptReconnect(
                      currentResourceRef.current,
                      loadFnRef.current,
                    );
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
                  attemptReconnect(
                    currentResourceRef.current,
                    loadFnRef.current,
                  );
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
                attemptReconnect(currentResourceRef.current, loadFnRef.current);
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
                    attemptReconnect(
                      currentResourceRef.current,
                      loadFnRef.current,
                    );
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
                attemptReconnect(currentResourceRef.current, loadFnRef.current);
              }
            };

            // 自動再生を試行
            videoRef.current.play().catch(() => {});
          } else {
            // 最大3回まで再試行
            if (attempts < 3) {
              setTimeout(
                () => setVideoStream(attempts + 1),
                50 * (attempts + 1),
              );
            }
          }
        };
        // 即座に試行し、失敗したら再試行
        setVideoStream();
      } catch {
        setStreamUrl(null);
        if (!isReconnect) {
          alert("ストリームの読み込みに失敗しました");
          setConnectionStatus("failed");
        } else {
          // 再接続中のエラーの場合、さらに再接続を試行
          attemptReconnect(resourceValue, loadFnRef.current);
        }
      } finally {
        setIsLoading(false);
      }
    },
    [
      setIsLoading,
      setConnectionStatus,
      setStreamUrl,
      pcRef,
      videoRef,
      isReconnectingRef,
      currentResourceRef,
      setReconnectAttempt,
      pendingTimeoutsRef,
      muteTimeoutRef,
      cleanupConnection,
      attemptReconnect,
      startHealthCheck,
      connectionStatus,
      setupConnectionEventListeners,
    ],
  );

  // loadFnRef に実際の関数を設定
  useEffect(() => {
    loadFnRef.current = load;
  }, [load]);

  return load;
}
