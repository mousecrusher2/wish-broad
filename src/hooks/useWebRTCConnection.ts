import { useState, useRef, useCallback } from "react";

export type ConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "failed"
  | "reconnecting";

interface WebRTCConnectionState {
  connectionStatus: ConnectionStatus;
  isLoading: boolean;
  reconnectAttempt: number;
  streamUrl: string | null;
}

interface WebRTCConnectionRefs {
  pcRef: React.RefObject<RTCPeerConnection | null>;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  currentResourceRef: React.RefObject<string>;
}

interface WebRTCConnectionActions {
  setConnectionStatus: (status: ConnectionStatus) => void;
  setIsLoading: (loading: boolean) => void;
  setReconnectAttempt: React.Dispatch<React.SetStateAction<number>>;
  setStreamUrl: (url: string | null) => void;
  cleanupConnection: () => void;
  setupConnectionEventListeners: (
    pc: RTCPeerConnection,
    onConnectionChange?: () => void,
  ) => void;
}

export function useWebRTCConnection(): [
  WebRTCConnectionState,
  WebRTCConnectionRefs,
  WebRTCConnectionActions,
] {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>("disconnected");
  const [isLoading, setIsLoading] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [streamUrl, setStreamUrl] = useState<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const currentResourceRef = useRef<string>("");
  const cleanupConnection = useCallback(() => {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setStreamUrl(null);
    setConnectionStatus("disconnected");
  }, []);

  // WebRTC接続のイベントリスナーを設定する関数
  const setupConnectionEventListeners = useCallback(
    (pc: RTCPeerConnection, onConnectionChange?: () => void) => {
      const handleConnectionStateChange = () => {
        console.log("Connection state changed:", pc.connectionState);

        switch (pc.connectionState) {
          case "connected":
            setConnectionStatus("connected");
            setReconnectAttempt(0); // 成功時は再接続カウンターをリセット
            break;
          case "disconnected":
          case "failed":
            setConnectionStatus("failed");
            break;
          case "connecting":
            setConnectionStatus("connecting");
            break;
        }

        // 外部のコールバックを実行（例：再接続トリガーなど）
        if (onConnectionChange) {
          onConnectionChange();
        }
      };

      const handleIceConnectionStateChange = () => {
        console.log("ICE connection state changed:", pc.iceConnectionState);

        switch (pc.iceConnectionState) {
          case "connected":
          case "completed":
            setConnectionStatus("connected");
            break;
          case "disconnected":
          case "failed":
            setConnectionStatus("failed");
            break;
        }

        if (onConnectionChange) {
          onConnectionChange();
        }
      };

      // イベントリスナーを追加
      pc.addEventListener("connectionstatechange", handleConnectionStateChange);
      pc.addEventListener(
        "iceconnectionstatechange",
        handleIceConnectionStateChange,
      );

      // クリーンアップ関数を返す
      return () => {
        pc.removeEventListener(
          "connectionstatechange",
          handleConnectionStateChange,
        );
        pc.removeEventListener(
          "iceconnectionstatechange",
          handleIceConnectionStateChange,
        );
      };
    },
    [setConnectionStatus, setReconnectAttempt],
  );

  const state: WebRTCConnectionState = {
    connectionStatus,
    isLoading,
    reconnectAttempt,
    streamUrl,
  };
  const refs: WebRTCConnectionRefs = {
    pcRef,
    videoRef,
    currentResourceRef,
  };
  const actions: WebRTCConnectionActions = {
    setConnectionStatus,
    setIsLoading,
    setReconnectAttempt,
    setStreamUrl,
    cleanupConnection,
    setupConnectionEventListeners,
  };

  return [state, refs, actions];
}
