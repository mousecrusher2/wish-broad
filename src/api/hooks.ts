import { useRef, useState } from "react";
import useSWR, { mutate as mutateGlobal, preload } from "swr";
import type { LiveSummary, LiveTokenStatus, User } from "../../shared/protocol";
import {
  createLiveToken,
  fetchCurrentUser,
  fetchLiveStreams,
  fetchLiveTokenStatus,
  UnauthorizedError,
} from "./client";

const currentUserKey = "current-user";
const liveStreamsKey = "live-streams";
const liveTokenStateKey = "live-token-state";

const swrOptions = {
  revalidateIfStale: false,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  shouldRetryOnError: false,
};

const swrSuspenseOptions = { ...swrOptions, suspense: true } as const;

type StableLiveTokenState =
  { status: "none" } | { status: "available"; token: string | null };

type LiveTokenState = { status: "loading" } | StableLiveTokenState;

type CurrentUserState =
  | { status: "loading" }
  | { status: "ready"; user: User }
  | { status: "error"; error: string };

/**
 * SWR がキーに対してキャッシュするデータ形式。キャッシュ用フェッチャーは
 * 失敗時も reject せず解決値を返す。SWR は新しいリクエストやローカルの `mutate` で
 * 置き換えられた古い解決済みリクエストを破棄するが、reject されたリクエストは
 * そのまま適用してしまうため、古い失敗が最新データを上書きするのを防ぐ。
 */
type Settled<T> =
  { status: "ready"; data: T } | { status: "error"; error: Error };

type AuthState =
  | { status: "authenticated"; user: User }
  | { status: "unauthenticated" }
  | { status: "error"; error: string };

type UseLiveStreamsState =
  | { status: "loading"; refresh: () => void }
  | { status: "error"; error: string; refresh: () => void }
  | { status: "retrying"; error: string; refresh: () => void }
  | { status: "ready"; refresh: () => void; streams: LiveSummary[] }
  | { status: "refreshing"; refresh: () => void; streams: LiveSummary[] };

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** 失敗時にログ出力とキャッシュが行われるよう SWR 用フェッチャーをラップする。 */
function settle<T>(
  key: string,
  fetcher: () => Promise<T>,
): () => Promise<Settled<T>> {
  return async () => {
    try {
      return { status: "ready", data: await fetcher() };
    } catch (error: unknown) {
      console.error(`Failed to fetch ${key}:`, error);
      return { status: "error", error: toError(error) };
    }
  };
}

function toStableLiveTokenState({
  hasToken,
}: LiveTokenStatus): StableLiveTokenState {
  return hasToken ? { status: "available", token: null } : { status: "none" };
}

const loadCurrentUser = settle(currentUserKey, fetchCurrentUser);
const loadLiveStreams = settle(liveStreamsKey, fetchLiveStreams);
const loadLiveTokenState = settle(liveTokenStateKey, async () =>
  toStableLiveTokenState(await fetchLiveTokenStatus()),
);

void preload(currentUserKey, loadCurrentUser);
void preload(liveStreamsKey, loadLiveStreams);
void preload(liveTokenStateKey, loadLiveTokenState);

function isUnauthorized(settled: Settled<unknown> | undefined): boolean {
  return (
    settled?.status === "error" && settled.error instanceof UnauthorizedError
  );
}

/**
 * `/api/me` の結果から認証状態を返す。結果が出るまでサスペンドする。配信一覧とトークン状態の
 * 取得が認証切れで失敗した場合も未認証とする。
 */
export function useSuspenseAuthState(): AuthState {
  const { data: currentUser } = useSWR(
    currentUserKey,
    loadCurrentUser,
    swrSuspenseOptions,
  );
  const { data: liveStreams } = useSWR<Settled<LiveSummary[]>>(
    liveStreamsKey,
    loadLiveStreams,
    swrOptions,
  );
  const { data: liveTokenState } = useSWR<Settled<StableLiveTokenState>>(
    liveTokenStateKey,
    loadLiveTokenState,
    swrOptions,
  );

  if (
    [currentUser, liveStreams, liveTokenState].some((settled) =>
      isUnauthorized(settled),
    )
  ) {
    return { status: "unauthenticated" };
  }

  if (currentUser.status === "error") {
    return { status: "error", error: currentUser.error.message };
  }

  return { status: "authenticated", user: currentUser.data };
}

export function useCurrentUser(): CurrentUserState {
  const { data } = useSWR<Settled<User>>(
    currentUserKey,
    loadCurrentUser,
    swrOptions,
  );

  if (data?.status === "ready") {
    return { status: "ready", user: data.data };
  }

  if (data?.status === "error") {
    return { status: "error", error: data.error.message };
  }

  return { status: "loading" };
}

export function useLiveStreams(): UseLiveStreamsState {
  const { data, isValidating, mutate } = useSWR<Settled<LiveSummary[]>>(
    liveStreamsKey,
    loadLiveStreams,
    swrOptions,
  );
  const refreshInFlightRef = useRef(false);

  const refresh = () => {
    if (refreshInFlightRef.current) {
      return;
    }

    refreshInFlightRef.current = true;
    void mutate().finally(() => {
      refreshInFlightRef.current = false;
    });
  };

  if (data?.status === "ready") {
    if (isValidating) {
      return { status: "refreshing", refresh, streams: data.data };
    }

    return { status: "ready", refresh, streams: data.data };
  }

  if (data?.status === "error") {
    if (isValidating) {
      return { status: "retrying", error: data.error.message, refresh };
    }

    return { status: "error", error: data.error.message, refresh };
  }

  return { status: "loading", refresh };
}

export async function revalidateLiveStreams(): Promise<void> {
  await mutateGlobal(liveStreamsKey);
}

/**
 * 配信一覧を取得し直してキャッシュを置き換え、`userId` が配信中かを返す。
 *
 * @returns 一覧を取得できなかった場合は null。
 */
export async function fetchIsUserLive(userId: string): Promise<boolean | null> {
  // 引数なしの mutate は表示中のフックがないと再取得しないため、取得した結果を直接渡す。
  const liveStreams = await mutateGlobal(liveStreamsKey, loadLiveStreams(), {
    revalidate: false,
  });
  if (liveStreams?.status !== "ready") {
    return null;
  }
  return liveStreams.data.some((live) => live.owner.userId === userId);
}

export function useLiveToken() {
  const [overrideState, setOverrideState] = useState<LiveTokenState | null>(
    null,
  );
  const { data, mutate } = useSWR<Settled<StableLiveTokenState>>(
    liveTokenStateKey,
    loadLiveTokenState,
    swrOptions,
  );

  const state: LiveTokenState =
    overrideState ??
    (data?.status === "ready" ? data.data : { status: "loading" });
  const error =
    overrideState === null && data?.status === "error"
      ? data.error.message
      : null;

  /** トークンステータスを再検証する。失敗時は `error` として公開される。 */
  const fetchTokenStatus = async (): Promise<void> => {
    setOverrideState({ status: "loading" });
    try {
      await mutate();
    } finally {
      setOverrideState(null);
    }
  };

  /**
   * 新しい配信トークンを発行する。失敗時はログ出力され、`error` として公開される。
   *
   * @returns 新しいトークンが発行されたかどうか。
   */
  const createToken = async (): Promise<boolean> => {
    setOverrideState({ status: "loading" });
    try {
      const token = await createLiveToken();
      await mutate(
        { status: "ready", data: { status: "available", token } },
        { revalidate: false },
      );
      return true;
    } catch (createError: unknown) {
      console.error("Failed to create token:", createError);
      // 期限切れセッションの場合も認証ブートストラップ処理へ到達して
      // ログインプロンプトが表示されるよう、フェッチ失敗と同様に失敗をキャッシュする。
      await mutate(
        { status: "error", error: toError(createError) },
        { revalidate: false },
      );
      return false;
    } finally {
      setOverrideState(null);
    }
  };

  return {
    createToken,
    error,
    fetchTokenStatus,
    state,
  };
}
