// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const swr = vi.hoisted(() => ({
  data: new Map<string, unknown>(),
  fetchers: new Map<string, () => Promise<unknown>>(),
  options: new Map<string, Record<string, unknown>>(),
  validating: false,
  mutate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  globalMutate: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  preload: vi.fn<(...args: unknown[]) => void>(),
}));

vi.mock("swr", () => ({
  default: (
    key: string,
    fetcher: () => Promise<unknown>,
    options: Record<string, unknown>,
  ) => {
    swr.fetchers.set(key, fetcher);
    swr.options.set(key, options);
    return {
      data: swr.data.get(key),
      isValidating: swr.validating,
      mutate: swr.mutate,
    };
  },
  mutate: swr.globalMutate,
  preload: swr.preload,
}));

import {
  UnauthorizedError,
  revalidateLiveStreams,
  useBootstrapAuthState,
  useCurrentUser,
  useLiveStreams,
  useLiveToken,
  useSuspenseCurrentUser,
} from "./api";

const user = { userId: "u", displayName: "Alice" };
const streams = [{ owner: user }];

describe("API hooks", () => {
  beforeEach(() => {
    swr.data.clear();
    swr.fetchers.clear();
    swr.options.clear();
    swr.validating = false;
    swr.mutate.mockReset();
    swr.globalMutate.mockReset();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("resolves bootstrap auth from loading, success, errors, and unauthorized responses", () => {
    const hook = renderHook(() => useBootstrapAuthState());
    expect(hook.result.current).toEqual({ status: "loading" });
    swr.data.set("live-streams", ok(streams));
    hook.rerender();
    expect(hook.result.current).toEqual({ status: "authenticated" });
    swr.data.set("current-user", err(new UnauthorizedError()));
    hook.rerender();
    expect(hook.result.current).toEqual({ status: "unauthenticated" });
    swr.data.set("current-user", err(new Error("me failed")));
    swr.data.set("live-streams", err(new Error("lives failed")));
    swr.data.set("live-token-state", err(new Error("token failed")));
    hook.rerender();
    expect(hook.result.current).toEqual({
      status: "error",
      error: "me failed",
    });
  });

  it("uses consistent SWR cache options and prioritizes unauthorized results", () => {
    const hook = renderHook(() => useBootstrapAuthState());
    for (const key of ["current-user", "live-streams", "live-token-state"]) {
      expect(swr.options.get(key)).toEqual({
        revalidateIfStale: false,
        revalidateOnFocus: false,
        revalidateOnReconnect: false,
        shouldRetryOnError: false,
      });
    }
    swr.data.set("current-user", ok(user));
    swr.data.set("live-streams", err(new UnauthorizedError()));
    hook.rerender();
    expect(hook.result.current).toEqual({ status: "unauthenticated" });
    swr.data.set("live-streams", err(new Error("offline")));
    hook.rerender();
    expect(hook.result.current).toEqual({ status: "authenticated" });
    swr.data.clear();
    swr.data.set("live-token-state", err(new Error("token offline")));
    hook.rerender();
    expect(hook.result.current).toEqual({ status: "loading" });
  });

  it("presents current user states and the suspense fallback", () => {
    const current = renderHook(() => useCurrentUser());
    expect(current.result.current).toEqual({ status: "loading" });
    const suspense = renderHook(() => useSuspenseCurrentUser());
    expect(suspense.result.current.isErr()).toBe(true);
    expect(suspense.result.current._unsafeUnwrapErr().message).toBe(
      "Current user is unavailable",
    );
    expect(swr.options.get("current-user")).toMatchObject({ suspense: true });
    swr.data.set("current-user", ok(user));
    current.rerender();
    suspense.rerender();
    expect(current.result.current).toEqual({ status: "ready", user });
    expect(suspense.result.current).toEqual(ok(user));
    swr.data.set("current-user", err(new Error("offline")));
    current.rerender();
    expect(current.result.current).toEqual({
      status: "error",
      error: "offline",
    });
    expect(swr.options.get("current-user")).toEqual({
      revalidateIfStale: false,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      shouldRetryOnError: false,
    });
  });

  it("validates the authenticated token status endpoint", async () => {
    renderHook(() => useLiveToken());
    const fetcher = swr.fetchers.get("live-token-state");
    if (!fetcher) throw new Error("Missing SWR fetcher");
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ hasToken: true })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ hasToken: false })))
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response("{"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ hasToken: "yes" })))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockRejectedValueOnce(new Error("offline"));
    vi.stubGlobal("fetch", fetchSpy);

    expect(await fetcher()).toEqual(ok({ status: "available", token: null }));
    expect(await fetcher()).toEqual(ok({ status: "none" }));
    expect(await fetcher()).toMatchObject({
      error: expect.objectContaining({ message: "HTTP error! status: 503" }),
    });
    expect(await fetcher()).toMatchObject({ error: expect.any(SyntaxError) });
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch token status:",
      expect.any(SyntaxError),
    );
    expect(await fetcher()).toMatchObject({
      error: expect.objectContaining({
        message: "Unexpected live token response",
      }),
    });
    expect(await fetcher()).toMatchObject({
      error: expect.any(UnauthorizedError),
    });
    expect(await fetcher()).toMatchObject({
      error: expect.objectContaining({ message: "offline" }),
    });
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch token status:",
      expect.objectContaining({ message: "offline" }),
    );
    expect(fetchSpy).toHaveBeenCalledWith("/api/me/livetoken", {
      method: "GET",
      credentials: "include",
    });
  });

  it("presents live list loading, refresh, and retry states", () => {
    const hook = renderHook(() => useLiveStreams());
    expect(hook.result.current.status).toBe("loading");
    swr.data.set("live-streams", ok(streams));
    hook.rerender();
    expect(hook.result.current).toMatchObject({ status: "ready", streams });
    swr.validating = true;
    hook.rerender();
    expect(hook.result.current).toMatchObject({
      status: "refreshing",
      streams,
    });
    swr.data.set("live-streams", err(new Error("offline")));
    hook.rerender();
    expect(hook.result.current).toMatchObject({
      status: "retrying",
      error: "offline",
    });
    swr.validating = false;
    hook.rerender();
    expect(hook.result.current).toMatchObject({
      status: "error",
      error: "offline",
    });
  });

  it("coalesces concurrent refreshes and permits another after completion", async () => {
    let finish: ((value: unknown) => void) | undefined;
    swr.mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    swr.mutate.mockResolvedValue(ok(streams));
    const hook = renderHook(() => useLiveStreams());
    act(() => {
      hook.result.current.refresh();
      hook.result.current.refresh();
    });
    expect(swr.mutate).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish?.(ok(streams));
    });
    act(() => hook.result.current.refresh());
    expect(swr.mutate).toHaveBeenCalledTimes(2);
    await act(async () => {
      await Promise.resolve();
    });
  });

  it("revalidates the live-streams cache", async () => {
    swr.globalMutate.mockResolvedValue(undefined);
    await revalidateLiveStreams();
    expect(swr.globalMutate).toHaveBeenCalledExactlyOnceWith("live-streams");
  });

  it("loads token status and distinguishes availability from absence", async () => {
    const hook = renderHook(() => useLiveToken());
    expect(hook.result.current.state).toEqual({ status: "loading" });
    swr.data.set("live-token-state", ok({ status: "none" }));
    hook.rerender();
    expect(hook.result.current.state).toEqual({ status: "none" });
    swr.mutate.mockResolvedValue(ok({ status: "available", token: null }));
    let result:
      | Awaited<ReturnType<typeof hook.result.current.fetchTokenStatus>>
      | undefined;
    await act(async () => {
      result = await hook.result.current.fetchTokenStatus();
    });
    expect(result?.isOk()).toBe(true);
    expect(hook.result.current.error).toBeNull();
  });

  it("reports unavailable and failing token status refreshes", async () => {
    const hook = renderHook(() => useLiveToken());
    swr.mutate
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(err(new Error("offline")));
    let unavailable:
      | Awaited<ReturnType<typeof hook.result.current.fetchTokenStatus>>
      | undefined;
    await act(async () => {
      unavailable = await hook.result.current.fetchTokenStatus();
    });
    expect(unavailable?.isErr()).toBe(true);
    expect(hook.result.current.error).toBe("Live token state is unavailable");
    let failed:
      | Awaited<ReturnType<typeof hook.result.current.fetchTokenStatus>>
      | undefined;
    await act(async () => {
      failed = await hook.result.current.fetchTokenStatus();
    });
    expect(failed?.isErr()).toBe(true);
    expect(hook.result.current.error).toBe("offline");
  });

  it("exposes the loading state while token status refresh is pending", async () => {
    swr.data.set("live-token-state", ok({ status: "available", token: null }));
    let finish: ((value: unknown) => void) | undefined;
    swr.mutate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const hook = renderHook(() => useLiveToken());
    expect(hook.result.current.state).toEqual({
      status: "available",
      token: null,
    });
    let request:
      ReturnType<typeof hook.result.current.fetchTokenStatus> | undefined;
    act(() => {
      request = hook.result.current.fetchTokenStatus();
    });
    expect(hook.result.current.state).toEqual({ status: "loading" });
    await act(async () => {
      finish?.(ok({ status: "none" }));
      await request;
    });
    expect(hook.result.current.state).toEqual({
      status: "available",
      token: null,
    });
    expect(hook.result.current.error).toBeNull();
  });

  it("exposes loading and resets the override after token creation completes", async () => {
    swr.data.set("live-token-state", ok({ status: "none" }));
    let finish: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    swr.mutate.mockResolvedValue(undefined);
    const hook = renderHook(() => useLiveToken());
    let request: ReturnType<typeof hook.result.current.createToken> | undefined;
    act(() => {
      request = hook.result.current.createToken();
    });
    expect(hook.result.current.state).toEqual({ status: "loading" });
    await act(async () => {
      finish?.(Response.json({ success: true, token: "new-token" }));
      await request;
    });
    expect(hook.result.current.state).toEqual({ status: "none" });
    expect(hook.result.current.error).toBeNull();
    expect(swr.mutate).toHaveBeenCalledWith(
      ok({ status: "available", token: "new-token" }),
      { revalidate: false },
    );
  });

  it("creates a token, caches it, and returns it only for the new token", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ success: true, token: "secret" })),
      );
    vi.stubGlobal("fetch", fetchSpy);
    swr.mutate.mockResolvedValue(ok({ status: "available", token: "secret" }));
    const hook = renderHook(() => useLiveToken());
    let result:
      Awaited<ReturnType<typeof hook.result.current.createToken>> | undefined;
    await act(async () => {
      result = await hook.result.current.createToken();
    });
    expect(result?.isOk()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith("/api/me/livetoken", {
      method: "POST",
      credentials: "include",
    });
    expect(swr.mutate).toHaveBeenCalledWith(
      ok({ status: "available", token: "secret" }),
      { revalidate: false },
    );
    expect(hook.result.current.error).toBeNull();
  });

  it.each([
    {
      response: new Response("unauthorized", { status: 401 }),
      error: "Unauthorized",
    },
    {
      response: new Response("failed", { status: 503 }),
      error: "HTTP error! status: 503",
    },
    { response: new Response("{"), error: null },
    {
      response: new Response(JSON.stringify({ success: true, token: 42 })),
      error: "Unexpected token creation response",
    },
  ])("reports token creation failures: $error", async ({ response, error }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    swr.mutate.mockResolvedValue(undefined);
    const hook = renderHook(() => useLiveToken());
    let result:
      Awaited<ReturnType<typeof hook.result.current.createToken>> | undefined;
    await act(async () => {
      result = await hook.result.current.createToken();
    });
    expect(result?.isErr()).toBe(true);
    if (error === null) {
      expect(hook.result.current.error).toEqual(expect.any(String));
      expect(console.error).toHaveBeenCalledWith(
        "Failed to create token:",
        expect.any(SyntaxError),
      );
    } else {
      expect(hook.result.current.error).toBe(error);
    }
    expect(swr.mutate).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
      { revalidate: false },
    );
  });

  it("logs a token creation transport failure and retains its message", async () => {
    const failure = new TypeError("network offline");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    swr.mutate.mockResolvedValue(undefined);
    const hook = renderHook(() => useLiveToken());
    let result:
      Awaited<ReturnType<typeof hook.result.current.createToken>> | undefined;
    await act(async () => {
      result = await hook.result.current.createToken();
    });
    expect(result?.isErr()).toBe(true);
    expect(hook.result.current.error).toBe("network offline");
    expect(console.error).toHaveBeenCalledWith(
      "Failed to create token:",
      failure,
    );
    expect(swr.mutate).toHaveBeenCalledWith(err(failure), {
      revalidate: false,
    });
  });
});
