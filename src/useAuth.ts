import useSWR from "swr";
import type { AuthState, User } from "./types";

async function fetchAuthState(): Promise<AuthState> {
  try {
    const response = await fetch("/api/me", { credentials: "include" });
    if (response.ok) {
      const userData = (await response.json()) as User;
      return { status: "authenticated", user: userData };
    }

    if (response.status === 401) {
      return { status: "unauthenticated" };
    }

    throw new Error(`Unexpected status code: ${String(response.status)}`);
  } catch (error) {
    console.error("Authentication check failed:", error);
    return {
      status: "error",
      message:
        error instanceof Error
          ? error.message
          : "Failed to fetch authentication status",
    };
  }
}

export function useAuth(): AuthState {
  const { data } = useSWR<AuthState>("/api/me", fetchAuthState, {
    suspense: true,
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });

  if (!data) {
    throw new Error("Authentication state is unavailable");
  }

  return data;
}
