import { useState, useEffect } from "react";

interface LiveTokenResponse {
  hastoken: boolean;
}

interface CreateTokenResponse {
  success: true;
  token: string;
}

export function useLiveToken() {
  const [hasToken, setHasToken] = useState<boolean>(false);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // トークンの状況を取得
  const fetchTokenStatus = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch("/api/me/livetoken", {
        method: "GET",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: LiveTokenResponse = await response.json();
      setHasToken(data.hastoken);

      // トークンが存在しない場合、既存のトークンをクリア
      if (!data.hastoken) {
        setToken(null);
      }
    } catch (err) {
      console.error("Failed to fetch token status:", err);
      setError(
        err instanceof Error ? err.message : "トークン状況の取得に失敗しました",
      );
      setHasToken(false);
      setToken(null);
    } finally {
      setIsLoading(false);
    }
  };

  // 新しいトークンを発行
  const createToken = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await fetch("/api/me/livetoken", {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data: CreateTokenResponse = await response.json();

      if (data.success) {
        setToken(data.token);
        setHasToken(true);
      } else {
        throw new Error("トークンの発行に失敗しました");
      }
    } catch (err) {
      console.error("Failed to create token:", err);
      setError(
        err instanceof Error ? err.message : "トークンの発行に失敗しました",
      );
    } finally {
      setIsLoading(false);
    }
  };

  // コンポーネントマウント時にトークン状況を取得
  useEffect(() => {
    fetchTokenStatus();
  }, []);

  return {
    hasToken,
    token,
    isLoading,
    error,
    fetchTokenStatus,
    createToken,
  };
}
