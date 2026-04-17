import { useCallback, useRef } from "react";
import useSWR from "swr";
import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";
import type { Live } from "./types";

type UseLiveStreamsState = {
  streams: Live[];
  isLoading: boolean;
  error: string | null;
  refresh: () => void;
};

async function fetchLiveStreams(): Promise<Result<Live[], Error>> {
  const userSchema = v.object({
    userId: v.string(),
    displayName: v.string(),
  });
  const liveSchema = v.object({
    owner: userSchema,
  });
  const liveListSchema = v.array(liveSchema);

  const responseResult = await fetch("/api/lives")
    .then((response) => ok(response))
    .catch((error: Error) => err(error));
  if (responseResult.isErr()) {
    console.error("Failed to fetch live streams:", responseResult.error);
    return err(responseResult.error);
  }

  const response = responseResult.value;
  if (!response.ok) {
    return err(new Error("配信リストの取得に失敗しました"));
  }

  const payloadResult = await response
    .json()
    .then((data: unknown) => ok(data))
    .catch((error: Error) => err(error));
  if (payloadResult.isErr()) {
    console.error("Failed to fetch live streams:", payloadResult.error);
    return err(payloadResult.error);
  }

  const parsedLiveList = v.safeParse(liveListSchema, payloadResult.value);
  if (!parsedLiveList.success) {
    return err(new Error("Unexpected live streams response"));
  }

  return ok(parsedLiveList.output);
}

export function useLiveStreams(): UseLiveStreamsState {
  const { data, isLoading, isValidating, mutate } = useSWR<
    Result<Live[], Error>
  >(
    "/api/lives",
    fetchLiveStreams,
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    },
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

  return {
    streams: data?.isOk() ? data.value : [],
    isLoading: isLoading || isValidating,
    error: data?.isErr() ? data.error.message : null,
    refresh,
  };
}
