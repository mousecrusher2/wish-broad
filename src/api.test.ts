import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("swr", async (importOriginal) => {
  const original = await importOriginal<typeof import("swr")>();
  return {
    ...original,
    preload: vi.fn<() => void>(),
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
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the current user when an API response is not 401", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(
        createJsonResponse({ displayName: "Alice", userId: "user-1" }),
      ),
    );
    vi.stubGlobal("fetch", fetchSpy);

    const result = await fetchCurrentUser();

    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw result.error;
    expect(result.value).toEqual({ displayName: "Alice", userId: "user-1" });
    expect(fetchSpy).toHaveBeenCalledWith("/api/me", {
      credentials: "include",
    });
  });

  it("validates /api/me status, JSON, and user shape", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 503 }))
      .mockResolvedValueOnce(new Response("{"))
      .mockResolvedValueOnce(
        createJsonResponse({ userId: 42, displayName: "Alice" }),
      );
    vi.stubGlobal("fetch", fetchSpy);
    const unexpectedStatus = await fetchCurrentUser();
    expect(unexpectedStatus.isErr()).toBe(true);
    if (unexpectedStatus.isOk()) throw new Error("Expected an error");
    expect(unexpectedStatus.error.message).toBe("Unexpected status code: 503");

    const invalidJson = await fetchCurrentUser();
    expect(invalidJson.isErr()).toBe(true);
    if (invalidJson.isOk()) throw new Error("Expected an error");
    expect(invalidJson.error).toBeInstanceOf(SyntaxError);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch current user:",
      invalidJson.error,
    );

    const invalidSchema = await fetchCurrentUser();
    expect(invalidSchema.isErr()).toBe(true);
    if (invalidSchema.isOk()) throw new Error("Expected an error");
    expect(invalidSchema.error.message).toBe("Unexpected /api/me response");
  });

  it("returns validated live streams and rejects malformed payloads", async () => {
    const streams = [{ owner: { userId: "u", displayName: "Alice" } }];
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(createJsonResponse(streams))
      .mockResolvedValueOnce(createJsonResponse([{ owner: { userId: 42 } }]))
      .mockResolvedValueOnce(new Response("not json"));
    vi.stubGlobal("fetch", fetchSpy);

    const success = await fetchLiveStreams();
    expect(success.isOk()).toBe(true);
    if (success.isErr()) throw success.error;
    expect(success.value).toEqual(streams);
    expect(fetchSpy).toHaveBeenCalledWith("/api/lives", {
      credentials: "include",
    });

    const invalidSchema = await fetchLiveStreams();
    expect(invalidSchema.isErr()).toBe(true);
    if (invalidSchema.isOk()) throw new Error("Expected an error");
    expect(invalidSchema.error.message).toBe(
      "Unexpected live streams response",
    );

    const invalidJson = await fetchLiveStreams();
    expect(invalidJson.isErr()).toBe(true);
    if (invalidJson.isOk()) throw new Error("Expected an error");
    expect(invalidJson.error).toBeInstanceOf(SyntaxError);
    expect(console.error).toHaveBeenCalledWith(
      "Failed to fetch live streams:",
      invalidJson.error,
    );
  });

  it("propagates network failures for both data endpoints", async () => {
    const networkError = new TypeError("offline");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(networkError));
    for (const read of [fetchCurrentUser, fetchLiveStreams]) {
      const result = await read();
      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("Expected an error");
      expect(result.error).toBe(networkError);
    }
    expect(console.error).toHaveBeenNthCalledWith(
      1,
      "Failed to fetch current user:",
      networkError,
    );
    expect(console.error).toHaveBeenNthCalledWith(
      2,
      "Failed to fetch live streams:",
      networkError,
    );
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
    expect(result.error.message).toBe("配信リストの取得に失敗しました");
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
      name: "UnauthorizedError",
      message: "Unauthorized",
    });
  });
});
