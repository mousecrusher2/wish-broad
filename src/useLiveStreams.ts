import { useState, useEffect } from "react";
import type { Live } from "./types";

interface UseLiveStreamsResult {
  streams: Live[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
}

function isLive(value: unknown): value is Live {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const owner = (value as { owner?: unknown }).owner;
  if (typeof owner !== "object" || owner === null) {
    return false;
  }

  return (
    typeof (owner as { userId?: unknown }).userId === "string" &&
    typeof (owner as { displayName?: unknown }).displayName === "string"
  );
}

function isLiveList(value: unknown): value is Live[] {
  return Array.isArray(value) && value.every(isLive);
}

export function useLiveStreams(): UseLiveStreamsResult {
  const [streams, setStreams] = useState<Live[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shouldRefresh, setShouldRefresh] = useState(0);

  useEffect(() => {
    const fetchStreams = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const response = await fetch("/api/lives");
        if (response.ok) {
          const data: unknown = await response.json();
          if (!isLiveList(data)) {
            throw new Error("Unexpected live streams response");
          }
          setStreams(data);
        } else {
          setError("配信リストの取得に失敗しました");
        }
      } catch (err) {
        console.error("Failed to fetch live streams:", err);
        setError("配信リストの取得中にエラーが発生しました");
      } finally {
        setIsLoading(false);
      }
    };

    void fetchStreams();
  }, [shouldRefresh]);

  const refresh = () => {
    setShouldRefresh((prev) => prev + 1);
  };

  return {
    streams,
    isLoading,
    error,
    refresh,
  };
}
