import { useState } from "react";
import useSWR from "swr";
import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";

type StableLiveTokenState =
  | { status: "none" }
  | { status: "available"; token: string | null };

type LiveTokenState = { status: "loading" } | StableLiveTokenState;

async function fetchLiveTokenState(): Promise<
  Result<StableLiveTokenState, Error>
> {
  const liveTokenResponseSchema = v.object({
    hasToken: v.boolean(),
  });

  const responseResult = await fetch("/api/me/livetoken", {
    method: "GET",
    credentials: "include",
  })
    .then((response) => ok(response))
    .catch((error: Error) => err(error));
  if (responseResult.isErr()) {
    console.error("Failed to fetch token status:", responseResult.error);
    return err(responseResult.error);
  }

  const response = responseResult.value;
  if (!response.ok) {
    return err(new Error(`HTTP error! status: ${String(response.status)}`));
  }

  const payloadResult = await response
    .json()
    .then((data: unknown) => ok(data))
    .catch((error: Error) => err(error));
  if (payloadResult.isErr()) {
    console.error("Failed to fetch token status:", payloadResult.error);
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

export function useLiveToken() {
  const [overrideState, setOverrideState] = useState<LiveTokenState | null>(
    null,
  );
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const { data, mutate } = useSWR<Result<StableLiveTokenState, Error>>(
    "/api/me/livetoken",
    fetchLiveTokenState,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
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
    const createTokenResponseSchema = v.object({
      success: v.literal(true),
      token: v.string(),
    });

    setOverrideState({ status: "loading" });
    setOverrideError(null);

    const run = async (): Promise<Result<void, Error>> => {
      const responseResult = await fetch("/api/me/livetoken", {
        method: "POST",
        credentials: "include",
      })
        .then((response) => ok(response))
        .catch((error: Error) => err(error));
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

      const payloadResult = await response
        .json()
        .then((data: unknown) => ok(data))
        .catch((error: Error) => err(error));
      if (payloadResult.isErr()) {
        console.error("Failed to create token:", payloadResult.error);
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
    state,
    error,
    fetchTokenStatus,
    createToken,
  };
}
