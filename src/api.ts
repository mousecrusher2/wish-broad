import { useCallback, useRef, useState } from "react";
import useSWR, { mutate as mutateGlobal, preload } from "swr";
import { err, ok, type Result } from "neverthrow";
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
const swrSuspenseOptions = {
  ...swrOptions,
  suspense: true,
};

type StableLiveTokenState =
  | { status: "none" }
  | { status: "available"; token: string | null };

type LiveTokenState = { status: "loading" } | StableLiveTokenState;

type CurrentUserState =
  | { status: "loading" }
  | { status: "ready"; user: User }
  | { status: "error"; error: string };

type DataState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: Error };

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

async function apiFetch(
  input: string,
  init?: RequestInit,
): Promise<Result<Response, Error>> {
  const responseResult = await fetch(input, {
    ...init,
    credentials: "include",
  })
    .then((response) => ok(response))
    .catch((error: Error) => err(error));
  if (responseResult.isErr()) {
    return err(responseResult.error);
  }

  const response = responseResult.value;
  if (response.status === 401) {
    return err(new UnauthorizedError());
  }

  return ok(response);
}

async function readJsonResponse(
  response: Response,
  errorLabel: string,
): Promise<Result<unknown, Error>> {
  return response
    .json()
    .then((data: unknown) => ok(data))
    .catch((error: Error) => {
      console.error(errorLabel, error);
      return err(error);
    });
}

export async function fetchCurrentUser(): Promise<Result<User, Error>> {
  const responseResult = await apiFetch("/api/me");
  if (responseResult.isErr()) {
    console.error("Failed to fetch current user:", responseResult.error);
    return err(responseResult.error);
  }

  const response = responseResult.value;
  if (!response.ok) {
    return err(new Error(`Unexpected status code: ${String(response.status)}`));
  }

  const payloadResult = await readJsonResponse(
    response,
    "Failed to fetch current user:",
  );
  if (payloadResult.isErr()) {
    return err(payloadResult.error);
  }

  const parsedUser = v.safeParse(userSchema, payloadResult.value);
  if (!parsedUser.success) {
    return err(new Error("Unexpected /api/me response"));
  }

  return ok(parsedUser.output);
}

export async function fetchLiveStreams(): Promise<Result<Live[], Error>> {
  const responseResult = await apiFetch("/api/lives");
  if (responseResult.isErr()) {
    console.error("Failed to fetch live streams:", responseResult.error);
    return err(responseResult.error);
  }

  const response = responseResult.value;
  if (!response.ok) {
    return err(new Error("配信リストの取得に失敗しました"));
  }

  const payloadResult = await readJsonResponse(
    response,
    "Failed to fetch live streams:",
  );
  if (payloadResult.isErr()) {
    return err(payloadResult.error);
  }

  const parsedLiveList = v.safeParse(liveListSchema, payloadResult.value);
  if (!parsedLiveList.success) {
    return err(new Error("Unexpected live streams response"));
  }

  return ok(parsedLiveList.output);
}

async function fetchLiveTokenState(): Promise<
  Result<StableLiveTokenState, Error>
> {
  const responseResult = await apiFetch("/api/me/livetoken", {
    method: "GET",
  });
  if (responseResult.isErr()) {
    console.error("Failed to fetch token status:", responseResult.error);
    return err(responseResult.error);
  }

  const response = responseResult.value;
  if (!response.ok) {
    return err(new Error(`HTTP error! status: ${String(response.status)}`));
  }

  const payloadResult = await readJsonResponse(
    response,
    "Failed to fetch token status:",
  );
  if (payloadResult.isErr()) {
    return err(payloadResult.error);
  }

  const parsedData = v.safeParse(liveTokenResponseSchema, payloadResult.value);
  if (!parsedData.success) {
    return err(new Error("Unexpected live token response"));
  }

  if (parsedData.output.hasToken) {
    return ok({ status: "available", token: null });
  }

  return ok({ status: "none" });
}

void preload(currentUserKey, fetchCurrentUser);
void preload(liveStreamsKey, fetchLiveStreams);
void preload(liveTokenStateKey, fetchLiveTokenState);

function toDataState<T>(result: Result<T, Error> | undefined): DataState<T> {
  if (!result) {
    return { status: "loading" };
  }

  if (result.isOk()) {
    return { status: "ready", data: result.value };
  }

  return { status: "error", error: result.error };
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
  const { data: currentUser } = useSWR<Result<User, Error>>(
    currentUserKey,
    fetchCurrentUser,
    swrOptions,
  );
  const { data: liveStreams } = useSWR<Result<Live[], Error>>(
    liveStreamsKey,
    fetchLiveStreams,
    swrOptions,
  );
  const { data: liveTokenState } = useSWR<Result<StableLiveTokenState, Error>>(
    liveTokenStateKey,
    fetchLiveTokenState,
    swrOptions,
  );

  return resolveBootstrapAuthState([
    toDataState(currentUser),
    toDataState(liveStreams),
    toDataState(liveTokenState),
  ]);
}

export function useCurrentUser(): CurrentUserState {
  const { data } = useSWR<Result<User, Error>>(
    currentUserKey,
    fetchCurrentUser,
    swrOptions,
  );

  if (data?.isOk()) {
    return { status: "ready", user: data.value };
  }

  if (data?.isErr()) {
    return { status: "error", error: data.error.message };
  }

  return { status: "loading" };
}

export function useSuspenseCurrentUser(): Result<User, Error> {
  const { data } = useSWR<Result<User, Error>>(
    currentUserKey,
    fetchCurrentUser,
    swrSuspenseOptions,
  );

  return data ?? err(new Error("Current user is unavailable"));
}

export function useLiveStreams(): UseLiveStreamsState {
  const { data, isValidating, mutate } = useSWR<Result<Live[], Error>>(
    liveStreamsKey,
    fetchLiveStreams,
    swrOptions,
  );
  const refreshInFlightRef = useRef(false);

  const refresh = useCallback(() => {
    if (refreshInFlightRef.current) {
      return;
    }

    refreshInFlightRef.current = true;
    void mutate().finally(() => {
      refreshInFlightRef.current = false;
    });
  }, [mutate]);

  if (data?.isOk()) {
    if (isValidating) {
      return { status: "refreshing", refresh, streams: data.value };
    }

    return { status: "ready", refresh, streams: data.value };
  }

  if (data?.isErr()) {
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
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const { data, mutate } = useSWR<Result<StableLiveTokenState, Error>>(
    liveTokenStateKey,
    fetchLiveTokenState,
    swrOptions,
  );

  const state =
    overrideState ??
    (data?.isOk() ? data.value : null) ??
    ({ status: "loading" } satisfies LiveTokenState);
  const error = overrideError ?? (data?.isErr() ? data.error.message : null);

  const fetchTokenStatus = async (): Promise<Result<void, Error>> => {
    setOverrideState({ status: "loading" });
    setOverrideError(null);

    const nextState = await mutate();
    setOverrideState(null);

    if (!nextState) {
      const unavailableError = new Error("Live token state is unavailable");
      setOverrideError(unavailableError.message);
      return err(unavailableError);
    }

    if (nextState.isErr()) {
      setOverrideError(nextState.error.message);
      return err(nextState.error);
    }

    setOverrideError(null);
    return ok(undefined);
  };

  const createToken = async (): Promise<Result<void, Error>> => {
    setOverrideState({ status: "loading" });
    setOverrideError(null);

    const run = async (): Promise<Result<void, Error>> => {
      const responseResult = await apiFetch("/api/me/livetoken", {
        method: "POST",
      });
      if (responseResult.isErr()) {
        console.error("Failed to create token:", responseResult.error);
        await mutate(err(responseResult.error), { revalidate: false });
        setOverrideError(responseResult.error.message);
        return err(responseResult.error);
      }

      const response = responseResult.value;
      if (!response.ok) {
        const responseError = new Error(
          `HTTP error! status: ${String(response.status)}`,
        );
        await mutate(err(responseError), { revalidate: false });
        setOverrideError(responseError.message);
        return err(responseError);
      }

      const payloadResult = await readJsonResponse(
        response,
        "Failed to create token:",
      );
      if (payloadResult.isErr()) {
        await mutate(err(payloadResult.error), { revalidate: false });
        setOverrideError(payloadResult.error.message);
        return err(payloadResult.error);
      }

      const parsedToken = v.safeParse(
        createTokenResponseSchema,
        payloadResult.value,
      );
      if (!parsedToken.success) {
        const payloadError = new Error("Unexpected token creation response");
        await mutate(err(payloadError), { revalidate: false });
        setOverrideError(payloadError.message);
        return err(payloadError);
      }

      const nextState: StableLiveTokenState = {
        status: "available",
        token: parsedToken.output.token,
      };
      await mutate(ok(nextState), { revalidate: false });
      setOverrideError(null);
      return ok(undefined);
    };

    return run().finally(() => {
      setOverrideState(null);
    });
  };

  return {
    createToken,
    error,
    fetchTokenStatus,
    state,
  };
}
