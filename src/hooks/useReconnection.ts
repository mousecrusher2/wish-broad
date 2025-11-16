import { useRef, useCallback, useEffect } from "react";
import type { ConnectionStatus } from "./useWebRTCConnection";
import { usePageVisibility } from "./usePageVisibility";

interface ReconnectionRefs {
  reconnectTimeoutRef: React.RefObject<number | null>;
  muteTimeoutRef: React.RefObject<number | null>;
  pendingTimeoutsRef: React.RefObject<Set<number>>;
  healthCheckIntervalRef: React.RefObject<number | null>;
  isReconnectingRef: React.RefObject<boolean>;
}

export function useReconnection(
  connectionStatus: ConnectionStatus,
  reconnectAttempt: number,
  setConnectionStatus: (status: ConnectionStatus) => void,
  setReconnectAttempt: React.Dispatch<React.SetStateAction<number>>,
  setIsLoading: (loading: boolean) => void,
  pcRef: React.RefObject<RTCPeerConnection | null>,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  currentResourceRef: React.RefObject<string>,
) {
  const isVisible = usePageVisibility();
  const lastCheckTimeRef = useRef<number | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const muteTimeoutRef = useRef<number | null>(null);
  const pendingTimeoutsRef = useRef<Set<number>>(new Set());
  const healthCheckIntervalRef = useRef<number | null>(null);
  const isReconnectingRef = useRef<boolean>(false);

  useEffect(() => {
    if (lastCheckTimeRef.current === null) {
      lastCheckTimeRef.current = Date.now();
    }
  }, []);

  // 接続状態を即座にチェックする関数
  const checkConnectionImmediate = useCallback(
    (attemptReconnectFn?: (resource: string) => void) => {
      if (!pcRef.current || !currentResourceRef.current) return false;

      const pc = pcRef.current;
      const needsReconnect =
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected" ||
        pc.iceConnectionState === "failed" ||
        pc.iceConnectionState === "disconnected";

      if (needsReconnect) {
        if (
          !isReconnectingRef.current &&
          connectionStatus !== "connecting" &&
          connectionStatus !== "connected" &&
          attemptReconnectFn
        ) {
          attemptReconnectFn(currentResourceRef.current);
          return true;
        }
      }

      // ビデオトラックの状態もチェック
      if (videoRef.current?.srcObject) {
        const stream = videoRef.current.srcObject as MediaStream;
        const tracks = stream.getTracks();
        const allTracksEnded = tracks.every(
          (track) => track.readyState === "ended",
        );

        if (allTracksEnded) {
          if (
            !isReconnectingRef.current &&
            connectionStatus !== "connecting" &&
            connectionStatus !== "connected" &&
            attemptReconnectFn
          ) {
            attemptReconnectFn(currentResourceRef.current);
            return true;
          }
        }
      }
      return false;
    },
    [connectionStatus, pcRef, videoRef, currentResourceRef],
  );
  // Page Visibility変更時の処理
  useEffect(() => {
    if (isVisible) {
      // ページが表示に戻った時
      lastCheckTimeRef.current = Date.now();

      // 少し遅延を設けて、すべてのhookが初期化された後にチェック
      const timeoutId = setTimeout(() => {
        if (pcRef.current && currentResourceRef.current) {
          // 接続状態を即座にチェックし、必要に応じて再接続
          checkConnectionImmediate();
        }
      }, 500); // 遅延を500msに増加

      return () => clearTimeout(timeoutId);
    }
  }, [isVisible, checkConnectionImmediate, pcRef, currentResourceRef]);

  // Page Visibilityが変更された時にヘルスチェック間隔を再調整する機能を提供
  const updateHealthCheckInterval = useCallback(
    (attemptReconnectFn: (resource: string) => void) => {
      if (healthCheckIntervalRef.current) {
        // 現在のヘルスチェックを停止して再開始
        clearInterval(healthCheckIntervalRef.current);
        const getCheckInterval = () => (isVisible ? 5000 : 30000);

        const performHealthCheck = () => {
          if (pcRef.current && currentResourceRef.current) {
            checkConnectionImmediate(attemptReconnectFn);
          }
        };

        healthCheckIntervalRef.current = window.setInterval(
          performHealthCheck,
          getCheckInterval(),
        );
      }
    },
    [isVisible, pcRef, currentResourceRef, checkConnectionImmediate],
  );

  const stopHealthCheck = useCallback(() => {
    if (healthCheckIntervalRef.current) {
      clearInterval(healthCheckIntervalRef.current);
      healthCheckIntervalRef.current = null;
    }
  }, []);

  const cleanupTimeouts = useCallback(() => {
    stopHealthCheck();

    // すべての保留中のタイムアウトをクリア
    pendingTimeoutsRef.current.forEach((timeoutId) => {
      clearTimeout(timeoutId);
    });
    pendingTimeoutsRef.current.clear();

    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (muteTimeoutRef.current) {
      clearTimeout(muteTimeoutRef.current);
      muteTimeoutRef.current = null;
    }
  }, [stopHealthCheck]);

  const attemptReconnect = useCallback(
    async (
      resourceValue: string,
      loadFn: (resource: string, isReconnect?: boolean) => Promise<void>,
    ) => {
      // より厳密な重複実行チェック
      if (isReconnectingRef.current) {
        return;
      }
      // 現在の接続状態をチェック
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
        if (isReconnectingRef.current) {
          isReconnectingRef.current = false;
        }
        loadFn(resourceValue, true);
      }, delay);

      reconnectTimeoutRef.current = timeoutId;
      pendingTimeoutsRef.current.add(timeoutId);
    },
    [
      connectionStatus,
      reconnectAttempt,
      setConnectionStatus,
      setIsLoading,
      setReconnectAttempt,
    ],
  );
  const startHealthCheck = useCallback(
    (attemptReconnectFn: (resource: string) => void) => {
      if (healthCheckIntervalRef.current) {
        clearInterval(healthCheckIntervalRef.current);
      }

      const performHealthCheck = () => {
        if (pcRef.current && currentResourceRef.current) {
          checkConnectionImmediate(attemptReconnectFn);
        }
      };

      // Page Visibilityに応じてチェック間隔を調整
      const getCheckInterval = () => {
        // ページが表示されている場合: 5秒
        // ページが非表示の場合: 30秒（ブラウザ制限を考慮してより長い間隔）
        return isVisible ? 5000 : 30000;
      };

      const scheduleNextCheck = () => {
        if (healthCheckIntervalRef.current) {
          clearInterval(healthCheckIntervalRef.current);
        }

        healthCheckIntervalRef.current = window.setInterval(() => {
          performHealthCheck();

          // 間隔が変更された可能性があるため、再スケジュール
          const currentInterval = getCheckInterval();
          if (healthCheckIntervalRef.current) {
            clearInterval(healthCheckIntervalRef.current);
            healthCheckIntervalRef.current = window.setInterval(
              performHealthCheck,
              currentInterval,
            );
          }
        }, getCheckInterval());
      };

      // 初回チェックを即座に実行
      performHealthCheck();

      // 定期チェックをスケジュール
      scheduleNextCheck();
    },
    [pcRef, currentResourceRef, checkConnectionImmediate, isVisible],
  );
  const refs: ReconnectionRefs = {
    reconnectTimeoutRef,
    muteTimeoutRef,
    pendingTimeoutsRef,
    healthCheckIntervalRef,
    isReconnectingRef,
  };
  return {
    refs,
    stopHealthCheck,
    cleanupTimeouts,
    attemptReconnect,
    startHealthCheck,
    updateHealthCheckInterval,
    checkConnectionImmediate,
  };
}
