// @vitest-environment jsdom
import { SWRConfig } from "swr";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { err, ok } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useBootstrapAuthState,
  useCurrentUser,
  useLiveStreams,
  useLiveToken,
} from "./api";
import type { User } from "./types";

vi.mock("swr", async (importOriginal) => {
  const original = await importOriginal<typeof import("swr")>();
  return { ...original, preload: vi.fn<() => void>() };
});

const user: User = { displayName: "Alice", userId: "user-1" };
const streams = [{ owner: user }];

function wrapper({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <SWRConfig
      value={{
        dedupingInterval: 0,
        provider: () => new Map(),
        revalidateOnFocus: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function setFetch(handler: typeof fetch) {
  const fetchMock = vi.fn<typeof fetch>(handler);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SWR-backed API hooks", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("transitions the current-user hook from loading to ready or error", async () => {
    setFetch(async (input) =>
      requestUrl(input) === "/api/me"
        ? response(user)
        : requestUrl(input) === "/api/lives"
          ? response(streams)
          : response({ hasToken: false }),
    );
    const ready = renderHook(() => useCurrentUser(), { wrapper });
    expect(ready.result.current.status).toBe("loading");
    await waitFor(() => {
      expect(ready.result.current.status).toBe("ready");
    });
    expect(ready.result.current).toEqual({ status: "ready", user });
    ready.unmount();

    setFetch(async () => response({}, 500));
    const failed = renderHook(() => useCurrentUser(), { wrapper });
    await waitFor(() => {
      expect(failed.result.current.status).toBe("error");
    });
    expect(failed.result.current).toMatchObject({ status: "error" });
  });

  it("resolves bootstrap auth across ready, unauthorized, error, and loading data", async () => {
    setFetch(async (input) => {
      switch (requestUrl(input)) {
        case "/api/me":
          return response(user);
        case "/api/lives":
          return response({}, 500);
        default:
          return response({ hasToken: false });
      }
    });
    const authenticated = renderHook(() => useBootstrapAuthState(), {
      wrapper,
    });
    await waitFor(() => {
      expect(authenticated.result.current.status).toBe("authenticated");
    });
    authenticated.unmount();

    setFetch(async (input) =>
      requestUrl(input) === "/api/me" ? response({}, 401) : response({}, 500),
    );
    const unauthenticated = renderHook(() => useBootstrapAuthState(), {
      wrapper,
    });
    await waitFor(() => {
      expect(unauthenticated.result.current.status).toBe("unauthenticated");
    });
    unauthenticated.unmount();

    setFetch(async () => response({}, 500));
    const unavailable = renderHook(() => useBootstrapAuthState(), { wrapper });
    await waitFor(() => {
      expect(unavailable.result.current.status).toBe("error");
    });
    expect(unavailable.result.current).toEqual({
      error: "Unexpected status code: 500",
      status: "error",
    });
  });

  it("stays loading until unresolved bootstrap data settles", async () => {
    let resolveCurrentUser: ((response: Response) => void) | undefined;
    setFetch(async (input) => {
      if (requestUrl(input) === "/api/me") {
        return new Promise<Response>((resolve) => {
          resolveCurrentUser = resolve;
        });
      }
      return response({}, 503);
    });
    const hook = renderHook(() => useBootstrapAuthState(), { wrapper });

    expect(hook.result.current).toEqual({ status: "loading" });
    await act(async () => {
      resolveCurrentUser?.(response(user));
    });
    await waitFor(() => {
      expect(hook.result.current).toEqual({ status: "authenticated" });
    });
  });

  it("loads live streams and coalesces refreshes while one revalidation is in flight", async () => {
    let releaseRefresh: (() => void) | undefined;
    let callCount = 0;
    const fetchMock = setFetch(async () => {
      callCount += 1;
      if (callCount === 2) {
        await new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        });
      }
      return response(streams);
    });

    const hook = renderHook(() => useLiveStreams(), { wrapper });
    expect(hook.result.current.status).toBe("loading");
    await waitFor(() => {
      expect(hook.result.current.status).toBe("ready");
    });

    act(() => {
      hook.result.current.refresh();
      hook.result.current.refresh();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(hook.result.current.status).toBe("refreshing");
    await act(async () => {
      releaseRefresh?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(hook.result.current.status).toBe("ready");
    });
    expect(hook.result.current).toMatchObject({ status: "ready", streams });

    act(() => {
      hook.result.current.refresh();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    await waitFor(() => {
      expect(hook.result.current.status).toBe("ready");
    });
  });

  it("shows retrying while a failed stream refresh is in flight", async () => {
    let releaseRefresh: (() => void) | undefined;
    let requestCount = 0;
    const fetchMock = setFetch(async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return response({}, 503);
      }
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
      return response(streams);
    });
    const hook = renderHook(() => useLiveStreams(), { wrapper });

    await waitFor(() => {
      expect(hook.result.current.status).toBe("error");
    });
    expect(hook.result.current).toMatchObject({
      error: "配信リストの取得に失敗しました",
      status: "error",
    });

    act(() => {
      hook.result.current.refresh();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    expect(hook.result.current).toMatchObject({
      error: "配信リストの取得に失敗しました",
      status: "retrying",
    });

    await act(async () => {
      releaseRefresh?.();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(hook.result.current.status).toBe("ready");
    });
    expect(hook.result.current).toMatchObject({ status: "ready", streams });
  });

  it("creates a one-time live token and exposes it only in hook state", async () => {
    const fetchMock = setFetch(async (_input, init) =>
      init?.method === "POST"
        ? response({ success: true, token: "one-time-secret" })
        : response({ hasToken: false }),
    );
    const hook = renderHook(() => useLiveToken(), { wrapper });
    await waitFor(() => {
      expect(hook.result.current.state.status).toBe("none");
    });

    let outcome;
    await act(async () => {
      outcome = await hook.result.current.createToken();
    });

    expect(outcome).toEqual(ok(undefined));
    expect(hook.result.current.state).toEqual({
      status: "available",
      token: "one-time-secret",
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/me/livetoken", {
      credentials: "include",
      method: "POST",
    });
  });

  it("reports token-status availability without exposing an existing token", async () => {
    const fetchMock = setFetch(async () => response({ hasToken: true }));
    const hook = renderHook(() => useLiveToken(), { wrapper });

    await waitFor(() => {
      expect(hook.result.current.state.status).toBe("available");
    });
    expect(hook.result.current.state).toEqual({
      status: "available",
      token: null,
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/me/livetoken", {
      credentials: "include",
      method: "GET",
    });
    let result;
    await act(async () => {
      result = await hook.result.current.fetchTokenStatus();
    });
    expect(result).toEqual(ok(undefined));
    expect(hook.result.current.state).toEqual({
      status: "available",
      token: null,
    });
  });

  it("keeps token-status refresh errors visible", async () => {
    let requestCount = 0;
    setFetch(async () => {
      requestCount += 1;
      return requestCount === 1
        ? response({ hasToken: false })
        : response({}, 503);
    });
    const hook = renderHook(() => useLiveToken(), { wrapper });
    await waitFor(() => {
      expect(hook.result.current.state.status).toBe("none");
    });

    let result;
    await act(async () => {
      result = await hook.result.current.fetchTokenStatus();
    });

    expect(result).toEqual(
      err(
        expect.objectContaining({
          message: "HTTP error! status: 503",
        }),
      ),
    );
    expect(hook.result.current.error).toBe("HTTP error! status: 503");
    expect(hook.result.current.state).toEqual({ status: "loading" });
  });

  it("reports malformed token status payloads and keeps the hook in loading state", async () => {
    setFetch(async () => response({ hasToken: "yes" }));
    const hook = renderHook(() => useLiveToken(), { wrapper });

    await waitFor(() => {
      expect(hook.result.current.error).toBe("Unexpected live token response");
    });
    expect(hook.result.current.state).toEqual({ status: "loading" });
  });

  it("reports token-status JSON parsing errors", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failure = new SyntaxError("malformed token status JSON");
    const responseWithInvalidJson = new Response("invalid");
    vi.spyOn(responseWithInvalidJson, "json").mockRejectedValue(failure);
    setFetch(async () => responseWithInvalidJson);
    const hook = renderHook(() => useLiveToken(), { wrapper });

    await waitFor(() => {
      expect(consoleError).toHaveBeenCalledWith(
        "Failed to fetch token status:",
        failure,
      );
    });
    expect(hook.result.current.error).toBe(failure.message);
    expect(hook.result.current.state).toEqual({ status: "loading" });
  });

  it("logs network failures while refreshing token status", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const failure = new Error("token status offline");
    setFetch(async () => {
      throw failure;
    });
    const hook = renderHook(() => useLiveToken(), { wrapper });

    await waitFor(() => {
      expect(hook.result.current.error).toBe(failure.message);
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to fetch token status:",
      failure,
    );
  });

  it("restores loading and clears a prior error while creating a token", async () => {
    let postCount = 0;
    let resolveSecondPost: ((response: Response) => void) | undefined;
    const fetchMock = setFetch(async (_input, init) => {
      if (init?.method !== "POST") return response({ hasToken: false });

      postCount += 1;
      if (postCount === 1) return response({}, 503);

      return new Promise<Response>((resolve) => {
        resolveSecondPost = resolve;
      });
    });
    const hook = renderHook(() => useLiveToken(), { wrapper });
    await waitFor(() => {
      expect(hook.result.current.state.status).toBe("none");
    });

    let failedResult: unknown;
    await act(async () => {
      failedResult = await hook.result.current.createToken();
    });
    expect(failedResult).toEqual(
      err(expect.objectContaining({ message: "HTTP error! status: 503" })),
    );
    expect(hook.result.current).toMatchObject({
      error: "HTTP error! status: 503",
      state: { status: "loading" },
    });

    let successfulResult: unknown;
    let successfulPromise: Promise<unknown> | undefined;
    await act(async () => {
      successfulPromise = hook.result.current.createToken();
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
    expect(hook.result.current).toMatchObject({
      error: null,
      state: { status: "loading" },
    });

    await act(async () => {
      resolveSecondPost?.(
        response({ success: true, token: "refreshed-secret" }),
      );
      if (!successfulPromise) throw new Error("Token creation did not start");
      successfulResult = await successfulPromise;
    });
    expect(successfulResult).toEqual(ok(undefined));
    expect(hook.result.current).toMatchObject({
      error: null,
      state: { status: "available", token: "refreshed-secret" },
    });
  });

  it("surfaces network and JSON parsing failures while creating a token", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const networkFailure = new Error("offline");
    const fetchMock = setFetch(async (_input, init) => {
      if (init?.method === "POST") {
        throw networkFailure;
      }
      return response({ hasToken: false });
    });
    const networkHook = renderHook(() => useLiveToken(), { wrapper });
    await waitFor(() => {
      expect(networkHook.result.current.state.status).toBe("none");
    });

    let networkResult;
    await act(async () => {
      networkResult = await networkHook.result.current.createToken();
    });
    expect(networkResult).toEqual(err(networkFailure));
    expect(networkHook.result.current.error).toBe("offline");
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to create token:",
      networkFailure,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(networkHook.result.current.state).toEqual({ status: "loading" });
    networkHook.unmount();

    const jsonFetchMock = setFetch(async (_input, init) =>
      init?.method === "POST"
        ? new Response("invalid json")
        : response({ hasToken: false }),
    );
    const jsonHook = renderHook(() => useLiveToken(), { wrapper });
    await waitFor(() => {
      expect(jsonHook.result.current.state.status).toBe("none");
    });
    let jsonResult;
    await act(async () => {
      jsonResult = await jsonHook.result.current.createToken();
    });

    expect(jsonResult).toEqual(
      err(expect.objectContaining({ name: "SyntaxError" })),
    );
    expect(jsonHook.result.current.error).toContain("invalid json");
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to create token:",
      expect.any(SyntaxError),
    );
    expect(jsonFetchMock).toHaveBeenCalledTimes(2);
    expect(jsonHook.result.current.state).toEqual({ status: "loading" });
  });

  it.each([
    ["HTTP error! status: 503", async () => response({}, 503)],
    [
      "Unexpected token creation response",
      async () => response({ token: "missing success" }),
    ],
  ])("surfaces token creation errors: %s", async (message, fetchResponse) => {
    const fetchMock = setFetch(async (_input, init) =>
      init?.method === "POST" ? fetchResponse() : response({ hasToken: false }),
    );
    const hook = renderHook(() => useLiveToken(), { wrapper });
    await waitFor(() => {
      expect(hook.result.current.state.status).toBe("none");
    });

    let result;
    await act(async () => {
      result = await hook.result.current.createToken();
    });

    expect(result).toEqual(err(expect.objectContaining({ message })));
    expect(hook.result.current.error).toBe(message);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hook.result.current.state).toEqual({ status: "loading" });
  });
});
