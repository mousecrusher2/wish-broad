import useSWR from "swr";
import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";
import type { AuthState } from "./types";

async function fetchAuthState(): Promise<Result<AuthState, Error>> {
  const userSchema = v.object({
    userId: v.string(),
    displayName: v.string(),
  });

  const responseResult = await fetch("/api/me", {
    credentials: "include",
  })
    .then((response) => ok(response))
    .catch((error: Error) => err(error));
  if (responseResult.isErr()) {
    console.error("Authentication check failed:", responseResult.error);
    return err(responseResult.error);
  }

  const response = responseResult.value;
  if (response.ok) {
    const userDataResult = await response
      .json()
      .then((data: unknown) => ok(data))
      .catch((error: Error) => err(error));
    if (userDataResult.isErr()) {
      console.error("Authentication check failed:", userDataResult.error);
      return err(userDataResult.error);
    }

    const parsedUser = v.safeParse(userSchema, userDataResult.value);
    if (!parsedUser.success) {
      return err(new Error("Unexpected /api/me response"));
    }

    return ok({ status: "authenticated", user: parsedUser.output });
  }

  if (response.status === 401) {
    return ok({ status: "unauthenticated" });
  }

  return err(new Error(`Unexpected status code: ${String(response.status)}`));
}

export function useAuth(): Result<AuthState, Error> {
  const { data } = useSWR<Result<AuthState, Error>>("/api/me", fetchAuthState, {
    suspense: true,
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    shouldRetryOnError: false,
  });

  if (!data) {
    return err(new Error("Authentication state is unavailable"));
  }

  return data;
}
