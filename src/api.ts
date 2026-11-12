import { useRef, useState } from "react";
import useSWR, { mutate as mutateGlobal, preload } from "swr";
import * as v from "valibot";
import type { Live, User } from "./types";

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
 * What SWR caches for a key. The cached fetchers resolve failures too: SWR
 * discards a resolved request that a newer request or a local `mutate` has
 * replaced, but it applies a rejected one regardless, which would let a stale
 * failure hide fresh data.
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
 * Fetch a same-origin API with the app cookie.
 *
 * @throws {UnauthorizedError} When the API answers 401.
 * @throws {TypeError} When the request fails before a response arrives.
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
 * Read a JSON response body and validate it against `schema`.
 *
 * @throws {SyntaxError} When the body is not JSON.
 * @throws {Error} With `invalidMessage` when the body does not match `schema`.
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
 * @throws {UnauthorizedError} When the session cookie is missing or expired.
 * @throws {Error} When the request fails or the response is not a user.
 */
export async function fetchCurrentUser(): Promise<User> {
  const response = await apiFetch("/api/me");
  if (!response.ok) {
    throw new Error(`Unexpected status code: ${String(response.status)}`);
  }

  return readJson(response, userSchema, "Unexpected /api/me response");
}

/**
 * @throws {UnauthorizedError} When the session cookie is missing or expired.
 * @throws {Error} When the request fails or the response is not a live list.
 */
export async function fetchLiveStreams(): Promise<Live[]> {
  const response = await apiFetch("/api/lives");
  if (!response.ok) {
    throw new Error("配信リストの取得に失敗しました");
  }

  return readJson(response, liveListSchema, "Unexpected live streams response");
}

/**
 * @throws {UnauthorizedError} When the session cookie is missing or expired.
 * @throws {Error} When the request fails or the response is not a token status.
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
 * Issue a new live token and return it.
 *
 * @throws {UnauthorizedError} When the session cookie is missing or expired.
 * @throws {Error} When the request fails or the response is not a new token.
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

/** Wrap a fetcher for SWR so that its failure is logged and cached. */
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

  /** Revalidate the token status. A failure is exposed through `error`. */
  const fetchTokenStatus = async (): Promise<void> => {
    setOverrideState({ status: "loading" });
    try {
      await mutate();
    } finally {
      setOverrideState(null);
    }
  };

  /**
   * Issue a new live token. A failure is logged and exposed through `error`.
   *
   * @returns Whether a new token was issued.
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
      // Cache the failure like a fetch failure so that an expired session
      // also reaches the auth bootstrap, which then shows the login prompt.
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
