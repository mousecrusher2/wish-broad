import { useRef, useState } from "react";
import useSWR, { mutate as mutateGlobal, preload } from "swr";
import * as v from "valibot";
import type { Live, User } from "../types";

const currentUserKey = "current-user";
const liveStreamsKey = "live-streams";
const liveTokenStateKey = "live-token-state";

const userSchema = v.object({
  userId: v.string(),
  displayName: v.string(),
});
const liveSchema = v.object({
  owner: userSchema,
});
const liveListSchema = v.array(liveSchema);
const liveTokenResponseSchema = v.object({
  hasToken: v.boolean(),
});
const createTokenResponseSchema = v.object({
  success: v.literal(true),
  token: v.string(),
});

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
  | { status: "ready"; refresh: () => void; streams: Live[] }
  | { status: "refreshing"; refresh: () => void; streams: Live[] };

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * アプリの Cookie を付与して同一オリジンの API にリクエストを送信する。
 *
 * @throws {UnauthorizedError} API が 401 を返した場合。
 * @throws {TypeError} レスポンス到着前にリクエストが失敗した場合。
 */
async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    credentials: "include",
  });
  if (response.status === 401) {
    throw new UnauthorizedError();
  }

  return response;
}

/**
 * JSON レスポンスボディを読み取り、`schema` に対して検証する。
 *
 * @throws {SyntaxError} ボディが有効な JSON でない場合。
 * @throws {Error} ボディが `schema` に一致しない場合（エラーメッセージは `invalidMessage`）。
 */
async function readJson<TOutput>(
  response: Response,
  schema: v.GenericSchema<unknown, TOutput>,
  invalidMessage: string,
): Promise<TOutput> {
  const parsed = v.safeParse(schema, await response.json());
  if (!parsed.success) {
    throw new Error(invalidMessage);
  }

  return parsed.output;
}

/**
 * @throws {UnauthorizedError} セッション Cookie が未設定または期限切れの場合。
 * @throws {Error} リクエストに失敗したか、レスポンスがユーザー情報でない場合。
 */
export async function fetchCurrentUser(): Promise<User> {
  const response = await apiFetch("/api/me");
  if (!response.ok) {
    throw new Error(`Unexpected status code: ${String(response.status)}`);
  }

  return readJson(response, userSchema, "Unexpected /api/me response");
}

/**
 * @throws {UnauthorizedError} セッション Cookie が未設定または期限切れの場合。
 * @throws {Error} リクエストに失敗したか、レスポンスが配信一覧でない場合。
 */
export async function fetchLiveStreams(): Promise<Live[]> {
  const response = await apiFetch("/api/lives");
  if (!response.ok) {
    throw new Error("配信リストの取得に失敗しました");
  }

  return readJson(response, liveListSchema, "Unexpected live streams response");
}

/**
 * @throws {UnauthorizedError} セッション Cookie が未設定または期限切れの場合。
 * @throws {Error} リクエストに失敗したか、レスポンスがトークンステータスでない場合。
 */
async function fetchLiveTokenState(): Promise<StableLiveTokenState> {
  const response = await apiFetch("/api/me/livetoken", {
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${String(response.status)}`);
  }

  const { hasToken } = await readJson(
    response,
    liveTokenResponseSchema,
    "Unexpected live token response",
  );
  return hasToken ? { status: "available", token: null } : { status: "none" };
}

/**
 * 新しい配信トークンを発行して返す。
 *
 * @throws {UnauthorizedError} セッション Cookie が未設定または期限切れの場合。
 * @throws {Error} リクエストに失敗したか、レスポンスが新規トークンでない場合。
 */
async function createLiveToken(): Promise<string> {
  const response = await apiFetch("/api/me/livetoken", {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${String(response.status)}`);
  }

  const { token } = await readJson(
    response,
    createTokenResponseSchema,
    "Unexpected token creation response",
  );
  return token;
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

const loadCurrentUser = settle(currentUserKey, fetchCurrentUser);
const loadLiveStreams = settle(liveStreamsKey, fetchLiveStreams);
const loadLiveTokenState = settle(liveTokenStateKey, fetchLiveTokenState);

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
  const { data: liveStreams } = useSWR<Settled<Live[]>>(
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
  const { data, isValidating, mutate } = useSWR<Settled<Live[]>>(
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
