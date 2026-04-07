import { useState, useEffect, useCallback } from "react";
import type { WHEPPlayerProps } from "./types";
import { useLiveStreams } from "./useLiveStreams";
import { OBSStreamingInfo } from "./OBSStreamingInfo";
import { useWebRTCConnection } from "./hooks/useWebRTCConnection";
import { useReconnection } from "./hooks/useReconnection";
import { useWebRTCLoad } from "./hooks/useWebRTCLoad";
import { usePageVisibility } from "./hooks/usePageVisibility";
import { ConnectionControls } from "./components/ConnectionControls";
import { StreamSelection } from "./components/StreamSelection";
import { VideoPlayer } from "./components/VideoPlayer";

export function WHEPPlayer({ user }: WHEPPlayerProps) {
  const [resource, setResource] = useState("");
  const isVisible = usePageVisibility();

  // WebRTC接続状態とrefを管理
  const [connectionState, connectionRefs, connectionActions] =
    useWebRTCConnection();
  const { connectionStatus, isLoading, reconnectAttempt, streamUrl } =
    connectionState;
  const { pcRef, videoRef, currentResourceRef } = connectionRefs;
  const {
    setConnectionStatus,
    setIsLoading,
    setReconnectAttempt,
    setStreamUrl,
    cleanupConnection,
    setupConnectionEventListeners,
  } = connectionActions;

  // ライブストリーム取得
  const {
    streams,
    isLoading: streamsLoading,
    error: streamsError,
    refresh,
  } = useLiveStreams();
  // 再接続とヘルスチェック機能
  const reconnectionHook = useReconnection(
    connectionStatus,
    reconnectAttempt,
    setConnectionStatus,
    setReconnectAttempt,
    setIsLoading,
    pcRef,
    videoRef,
    currentResourceRef,
  );
  const {
    refs: reconnectionRefs,
    cleanupTimeouts,
    attemptReconnect,
    startHealthCheck,
    updateHealthCheckInterval,
  } = reconnectionHook; // WebRTC接続処理
  const load = useWebRTCLoad(
    connectionStatus,
    setIsLoading,
    setConnectionStatus,
    setStreamUrl,
    pcRef,
    videoRef,
    reconnectionRefs.isReconnectingRef,
    currentResourceRef,
    setReconnectAttempt,
    reconnectionRefs.pendingTimeoutsRef,
    reconnectionRefs.muteTimeoutRef,
    cleanupConnection,
    attemptReconnect,
    startHealthCheck,
    setupConnectionEventListeners,
  );

  // クリーンアップ処理を拡張
  const enhancedCleanupConnection = useCallback(() => {
    cleanupTimeouts();
    cleanupConnection();
  }, [cleanupTimeouts, cleanupConnection]);
  // 手動再接続ボタン用の関数
  const handleReconnect = useCallback(() => {
    if (resource) {
      setReconnectAttempt(0);
      // isReconnectingRefの変更は避ける
      void load(resource);
    }
  }, [resource, setReconnectAttempt, load]);

  // 手動切断ボタン用の関数
  const handleDisconnect = useCallback(() => {
    enhancedCleanupConnection();
  }, [enhancedCleanupConnection]);

  const handleLoadClick = useCallback(() => {
    if (resource) {
      void load(resource);
    }
  }, [resource, load]);
  // コンポーネントのアンマウント時のクリーンアップ
  useEffect(() => {
    return () => {
      enhancedCleanupConnection();
    };
  }, [enhancedCleanupConnection]);
  // Page Visibilityの変更に応答してヘルスチェック間隔を調整
  useEffect(() => {
    if (resource && connectionStatus === "connected") {
      // 既存のヘルスチェックがある場合、間隔を更新
      const reconnectWrapper = (resourceToUse: string) => {
        void attemptReconnect(resourceToUse, load);
      };
      updateHealthCheckInterval(reconnectWrapper);
    }
  }, [
    isVisible,
    resource,
    connectionStatus,
    updateHealthCheckInterval,
    attemptReconnect,
    load,
  ]);

  return (
    <div className="container">
      <header>
        <h1>WHEP Player</h1>
        <div className="user-info">
          <span>ようこそ、{user.displayName} さん</span>
          <form method="POST" action="/logout">
            <button type="submit" className="logout-button">
              ログアウト
            </button>
          </form>
        </div>
      </header>
      <StreamSelection
        resource={resource}
        setResource={setResource}
        streams={streams}
        isLoading={isLoading}
        error={streamsError}
        onRefresh={refresh}
        onLoadClick={handleLoadClick}
        streamsLoading={streamsLoading}
      />{" "}
      <ConnectionControls
        connectionStatus={connectionStatus}
        reconnectAttempt={reconnectAttempt}
        hasResource={!!resource.trim()}
        onReconnect={handleReconnect}
        onDisconnect={handleDisconnect}
      />
      <VideoPlayer ref={videoRef} streamUrl={streamUrl} />
      <OBSStreamingInfo user={user} />
    </div>
  );
}
