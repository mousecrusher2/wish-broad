import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("swr", async (importOriginal) => {
  const original = await importOriginal<typeof import("swr")>();
  return {
    ...original,
    preload: vi.fn(),
  };
});

import { fetchCurrentUser, fetchLiveStreams, UnauthorizedError } from "./api";

function createJsonResponse(data: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
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
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          createJsonResponse({
            displayName: "Alice",
            userId: "user-1",
          }),
        ),
      ),
    );

    const result = await fetchCurrentUser();

    expect(result.isOk()).toBe(true);
  });

  it("treats non-401 API errors as authenticated responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("failed", { status: 500 }))),
    );

    const result = await fetchLiveStreams();

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).not.toBeInstanceOf(UnauthorizedError);
    }
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
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(UnauthorizedError);
    }
  });
});
