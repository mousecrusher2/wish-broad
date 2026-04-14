import useSWR from "swr";
import type { Live } from "./types";

type UseLiveStreamsResult = {
  streams: Live[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
};

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

async function fetchLiveStreams(): Promise<Live[]> {
  try {
    const response = await fetch("/api/lives");
    if (!response.ok) {
      throw new Error("配信リストの取得に失敗しました");
    }

    const data: unknown = await response.json();
    if (!isLiveList(data)) {
      throw new Error("Unexpected live streams response");
    }

    return data;
  } catch (error) {
    console.error("Failed to fetch live streams:", error);
    throw error instanceof Error
      ? error
      : new Error("配信リストの取得中にエラーが発生しました");
  }
}

export function useLiveStreams(): UseLiveStreamsResult {
  const { data, error, isLoading, isValidating, mutate } = useSWR<
    Live[],
    Error
  >("/api/lives", fetchLiveStreams, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });

  return {
    streams: data ?? [],
    isLoading: isLoading || isValidating,
    error: error instanceof Error ? error.message : null,
    refresh: () => {
      void mutate();
    },
  };
}
