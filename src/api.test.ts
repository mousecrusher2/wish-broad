import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mutateMock } = vi.hoisted(() => ({
  mutateMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));

vi.mock("swr", async (importOriginal) => {
  const original = await importOriginal<typeof import("swr")>();
  return {
    ...original,
    mutate: mutateMock,
    preload: vi.fn<() => void>(),
  };
});

import { mutate as mutateGlobal } from "swr";
import {
  fetchCurrentUser,
  fetchLiveStreams,
  revalidateLiveStreams,
  UnauthorizedError,
} from "./api";

function createJsonResponse(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), {
    ...init,
    headers,
  });
}

describe("api data layer", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the current user and keeps protected requests same-origin", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(
        createJsonResponse({ displayName: "Alice", userId: "user-1" }),
      ),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await fetchCurrentUser();

    expect(result._unsafeUnwrap()).toEqual({
      displayName: "Alice",
      userId: "user-1",
    });
    expect(fetch).toHaveBeenCalledWith("/api/me", {
      credentials: "include",
    });
  });

  it("treats non-401 API errors as authenticated responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("failed", { status: 500 }))),
    );

    const result = await fetchLiveStreams();

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new TypeError("Expected fetchLiveStreams to fail");
    }
    expect(result.error).not.toBeInstanceOf(UnauthorizedError);
  });

  it("returns unauthorized when an API response is 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response("Unauthorized", { status: 401 })),
      ),
    );

    const result = await fetchCurrentUser();

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new TypeError("Expected fetchCurrentUser to fail");
    }
    expect(result.error).toBeInstanceOf(UnauthorizedError);
    expect(result.error).toMatchObject({
      message: "Unauthorized",
      name: "UnauthorizedError",
    });
  });

  it("returns a fetch error without converting it to an HTTP status error", async () => {
    const failure = new Error("network offline");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));

    const result = await fetchCurrentUser();

    expect(result._unsafeUnwrapErr()).toBe(failure);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch current user:",
      failure,
    );
  });

  it("rejects other current-user HTTP statuses explicitly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 503 })),
    );

    const result = await fetchCurrentUser();

    expect(result._unsafeUnwrapErr()).toMatchObject({
      message: "Unexpected status code: 503",
    });
  });

  it.each([
    null,
    { displayName: "Alice" },
    { displayName: 9, userId: "user-1" },
  ])("rejects invalid current-user payloads: %j", async (payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(createJsonResponse(payload)),
    );

    expect((await fetchCurrentUser())._unsafeUnwrapErr()).toMatchObject({
      message: "Unexpected /api/me response",
    });
  });

  it("returns JSON parsing errors and reports them to the console", async () => {
    const failure = new SyntaxError("unexpected token");
    const response = new Response("bad json");
    vi.spyOn(response, "json").mockRejectedValue(failure);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    expect((await fetchCurrentUser())._unsafeUnwrapErr()).toBe(failure);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch current user:",
      failure,
    );
  });

  it("returns validated live lists and localizes HTTP failures", async () => {
    const streams = [{ owner: { displayName: "Alice", userId: "user-1" } }];
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(createJsonResponse(streams));
    vi.stubGlobal("fetch", fetchMock);
    expect((await fetchLiveStreams())._unsafeUnwrap()).toEqual(streams);
    expect(fetchMock).toHaveBeenCalledWith("/api/lives", {
      credentials: "include",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 503 })),
    );
    expect((await fetchLiveStreams())._unsafeUnwrapErr()).toMatchObject({
      message: "配信リストの取得に失敗しました",
    });
  });

  it("rejects malformed live lists and network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(createJsonResponse([{ owner: { userId: "u" } }])),
    );
    expect((await fetchLiveStreams())._unsafeUnwrapErr()).toMatchObject({
      message: "Unexpected live streams response",
    });

    const failure = new Error("offline");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    expect((await fetchLiveStreams())._unsafeUnwrapErr()).toBe(failure);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch live streams:",
      failure,
    );
  });

  it("revalidates the shared live-stream cache", async () => {
    await revalidateLiveStreams();

    expect(mutateGlobal).toHaveBeenCalledWith("live-streams");
  });

  it("returns a stream JSON parsing error and reports its label", async () => {
    const failure = new SyntaxError("invalid stream JSON");
    const response = new Response("invalid");
    vi.spyOn(response, "json").mockRejectedValue(failure);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));

    expect((await fetchLiveStreams())._unsafeUnwrapErr()).toBe(failure);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch live streams:",
      failure,
    );
  });
});
