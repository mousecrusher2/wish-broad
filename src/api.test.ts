import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("swr", async (importOriginal) => {
  const original = await importOriginal<typeof import("swr")>();
  return {
    ...original,
    preload: vi.fn<() => undefined>(),
  };
});

import { fetchCurrentUser, fetchLiveStreams, UnauthorizedError } from "./api";

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

    await expect(fetchCurrentUser()).resolves.toEqual({
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

    await expect(fetchLiveStreams()).rejects.not.toBeInstanceOf(
      UnauthorizedError,
    );
  });

  it("throws UnauthorizedError when an API response is 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(new Response("Unauthorized", { status: 401 })),
      ),
    );

    await expect(fetchCurrentUser()).rejects.toBeInstanceOf(UnauthorizedError);
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

    await expect(fetchCurrentUser()).rejects.toMatchObject({
      message: "Unexpected /api/me response",
    });
  });

  it("returns validated live lists and localizes HTTP failures", async () => {
    const streams = [{ owner: { displayName: "Alice", userId: "user-1" } }];
    const fetchMock = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(createJsonResponse(streams));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchLiveStreams()).resolves.toEqual(streams);
    expect(fetchMock).toHaveBeenCalledWith("/api/lives", {
      credentials: "include",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 503 })),
    );
    await expect(fetchLiveStreams()).rejects.toMatchObject({
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
    await expect(fetchLiveStreams()).rejects.toMatchObject({
      message: "Unexpected live streams response",
    });

    const failure = new Error("offline");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    await expect(fetchLiveStreams()).rejects.toBe(failure);
  });
});
