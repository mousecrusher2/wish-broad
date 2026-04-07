import { use } from "react";
import type { AuthState, User } from "./types";

// React の外側で実行する認証確認関数
export async function checkAuth(): Promise<AuthState> {
  try {
    const response = await fetch("/api/me", { credentials: "include" });
    if (response.ok) {
      const userData = (await response.json()) as User;
      return { status: "authenticated", user: userData };
    }

    if (response.status === 401) {
      return { status: "unauthenticated" };
    }

    // 200,401 以外はエラー扱い
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

// Suspense から使うラッパー
export function useAuthFromPromise(promise: Promise<AuthState>): AuthState {
  return use(promise);
}
