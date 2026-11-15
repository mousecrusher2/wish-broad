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

type DataState<T> = { status: "loading" } | Settled<T>;

type BootstrapAuthState =
  | { status: "loading" }
  | { status: "authenticated" }
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

function toDataState<T>(settled: Settled<T> | undefined): DataState<T> {
  return settled ?? { status: "loading" };
}

function hasUnauthorizedError(states: DataState<unknown>[]): boolean {
  return states.some((state) => {
    return state.status === "error" && state.error instanceof UnauthorizedError;
  });
}

function hasReadyData(states: DataState<unknown>[]): boolean {
  return states.some((state) => state.status === "ready");
}

function resolveBootstrapAuthState(
  states: DataState<unknown>[],
): BootstrapAuthState {
  if (hasUnauthorizedError(states)) {
    return { status: "unauthenticated" };
  }

  if (hasReadyData(states)) {
    return { status: "authenticated" };
  }

  const errors = states.filter((state) => state.status === "error");
  if (errors.length === states.length) {
    return {
      error: errors[0]?.error.message ?? "Authentication state is unavailable",
      status: "error",
    };
  }

  return { status: "loading" };
}

export function useBootstrapAuthState(): BootstrapAuthState {
  const { data: currentUser } = useSWR<Settled<User>>(
    currentUserKey,
    loadCurrentUser,
    swrOptions,
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

  return resolveBootstrapAuthState([
    toDataState(currentUser),
    toDataState(liveStreams),
    toDataState(liveTokenState),
  ]);
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
