import { useState, useEffect } from "react";

interface LiveTokenResponse {
  hasToken: boolean;
}

interface CreateTokenResponse {
  success: true;
  token: string;
}

type LiveTokenState =
  | { status: "loading" }
  | { status: "none" }
  | { status: "available"; token: string | null }
  | { status: "error"; message: string };

export function useLiveToken() {
  const [state, setState] = useState<LiveTokenState>({ status: "loading" });

  // トークンの状況を取得
  const fetchTokenStatus = async () => {
    try {
      setState({ status: "loading" });

      const response = await fetch("/api/me/livetoken", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: LiveTokenResponse = await response.json();

      if (data.hasToken) {
        setState({ status: "available", token: null });
      } else {
        setState({ status: "none" });
      }
    } catch (err) {
      console.error("Failed to fetch token status:", err);
      setState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : "トークン状況の取得に失敗しました",
      });
    }
  };

  // 新しいトークンを発行
  const createToken = async () => {
    try {
      setState({ status: "loading" });

      const response = await fetch("/api/me/livetoken", {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: CreateTokenResponse = await response.json();

      if (data.success) {
        setState({ status: "available", token: data.token });
      } else {
        throw new Error("トークンの発行に失敗しました");
      }
    } catch (err) {
      console.error("Failed to create token:", err);
      setState({
        status: "error",
        message:
          err instanceof Error
            ? err.message
            : "トークンの発行に失敗しました",
      });
    }
  };

  // コンポーネントマウント時にトークン状況を取得
  useEffect(() => {
    fetchTokenStatus();
  }, []);

  return {
    state,
    fetchTokenStatus,
    createToken,
  };
}
