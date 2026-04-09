import { useState } from "react";
import useSWR from "swr";

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

function isLiveTokenResponse(value: unknown): value is LiveTokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { hasToken?: unknown }).hasToken === "boolean"
  );
}

function isCreateTokenResponse(value: unknown): value is CreateTokenResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { success?: unknown }).success === true &&
    typeof (value as { token?: unknown }).token === "string"
  );
}

async function fetchLiveTokenState(): Promise<LiveTokenState> {
  try {
    const response = await fetch("/api/me/livetoken", {
      method: "GET",
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${String(response.status)}`);
    }

    const data: unknown = await response.json();
    if (!isLiveTokenResponse(data)) {
      throw new Error("Unexpected live token response");
    }

    if (data.hasToken) {
      return { status: "available", token: null };
    }

    return { status: "none" };
  } catch (error) {
    console.error("Failed to fetch token status:", error);
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "トークン状況の取得に失敗しました",
    };
  }
}

export function useLiveToken() {
  const [overrideState, setOverrideState] = useState<LiveTokenState | null>(
    null,
  );
  const { data, mutate } = useSWR<LiveTokenState>(
    "/api/me/livetoken",
    fetchLiveTokenState,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
  );

  const state = overrideState ?? data ?? { status: "loading" };

  const fetchTokenStatus = async () => {
    setOverrideState({ status: "loading" });
    await mutate();
    setOverrideState(null);
  };

  const createToken = async () => {
    setOverrideState({ status: "loading" });

    try {
      const response = await fetch("/api/me/livetoken", {
        method: "POST",
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${String(response.status)}`);
      }

      const nextData: unknown = await response.json();
      if (!isCreateTokenResponse(nextData)) {
        throw new Error("Unexpected token creation response");
      }

      const nextState: LiveTokenState = {
        status: "available",
        token: nextData.token,
      };
      await mutate(nextState, { revalidate: false });
    } catch (error) {
      console.error("Failed to create token:", error);
      await mutate(
        {
          status: "error",
          message:
            error instanceof Error
              ? error.message
              : "トークンの発行に失敗しました",
        } satisfies LiveTokenState,
        { revalidate: false },
      );
    } finally {
      setOverrideState(null);
    }
  };

  return {
    state,
    fetchTokenStatus,
    createToken,
  };
}
