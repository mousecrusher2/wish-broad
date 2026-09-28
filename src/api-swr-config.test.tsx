// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { err, ok } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockSWRHook = (
  key: string,
  fetcher: unknown,
  options?: unknown,
) => {
  data?: unknown;
  isValidating?: boolean;
  mutate?: (...args: unknown[]) => Promise<unknown>;
};

const { useSWRMock } = vi.hoisted(() => ({
  useSWRMock: vi.fn<MockSWRHook>(),
}));

vi.mock("swr", async (importOriginal) => {
  const original = await importOriginal<typeof import("swr")>();
  return {
    ...original,
    default: useSWRMock,
    preload: vi.fn<() => void>(),
  };
});

import {
  useBootstrapAuthState,
  useCurrentUser,
  useLiveStreams,
  useLiveToken,
  useSuspenseCurrentUser,
} from "./api";

const standardOptions = {
  revalidateIfStale: false,
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
  shouldRetryOnError: false,
};

describe("SWR hook configuration", () => {
  afterEach(() => {
    cleanup();
    useSWRMock.mockReset();
  });

  it("uses the same no-automatic-revalidation policy for ordinary hooks", () => {
    useSWRMock.mockReturnValue({
      data: undefined,
      isValidating: false,
      mutate: vi.fn<() => Promise<unknown>>(),
    });

    renderHook(() => useBootstrapAuthState());
    renderHook(() => useCurrentUser());
    renderHook(() => useLiveStreams());
    renderHook(() => useLiveToken());

    const hookCalls = useSWRMock.mock.calls;
    expect(hookCalls.map(([key]) => key)).toEqual([
      "current-user",
      "live-streams",
      "live-token-state",
      "current-user",
      "live-streams",
      "live-token-state",
    ]);
    for (const [, , options] of hookCalls) {
      expect(options).toEqual(standardOptions);
    }
  });

  it("enables suspense for the suspense current-user hook and provides a fallback result", () => {
    useSWRMock.mockReturnValue({ data: undefined });

    const hook = renderHook(() => useSuspenseCurrentUser());

    expect(useSWRMock).toHaveBeenCalledWith(
      "current-user",
      expect.any(Function),
      { ...standardOptions, suspense: true },
    );
    expect(hook.result.current).toEqual(
      err(new Error("Current user is unavailable")),
    );
  });

  it("reports when a token-status revalidation returns no cached result", async () => {
    const mutate = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
    useSWRMock.mockReturnValue({ data: undefined, mutate });
    const hook = renderHook(() => useLiveToken());

    let result: unknown;
    await act(async () => {
      result = await hook.result.current.fetchTokenStatus();
    });

    expect(mutate).toHaveBeenCalledOnce();
    expect(result).toEqual(err(new Error("Live token state is unavailable")));
    expect(hook.result.current).toMatchObject({
      error: "Live token state is unavailable",
      state: { status: "loading" },
    });
  });

  it("clears an old token-status error while a new revalidation is pending", async () => {
    let callCount = 0;
    let resolveSecondMutation: ((value: unknown) => void) | undefined;
    const mutate = vi.fn<() => Promise<unknown>>().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) {
        return Promise.resolve(err(new Error("first refresh failed")));
      }
      return new Promise((resolve) => {
        resolveSecondMutation = resolve;
      });
    });
    useSWRMock.mockReturnValue({
      data: ok({ status: "none" }),
      mutate,
    });
    const hook = renderHook(() => useLiveToken());

    await act(async () => {
      await hook.result.current.fetchTokenStatus();
    });
    expect(hook.result.current.error).toBe("first refresh failed");

    let secondResult: Promise<unknown> | undefined;
    await act(async () => {
      secondResult = hook.result.current.fetchTokenStatus();
      await Promise.resolve();
    });
    expect(hook.result.current).toMatchObject({
      error: null,
      state: { status: "loading" },
    });

    await act(async () => {
      resolveSecondMutation?.(err(new Error("latest refresh failed")));
      if (!secondResult) throw new Error("Token status refresh did not start");
      await secondResult;
    });
    expect(hook.result.current.error).toBe("latest refresh failed");
  });
});
