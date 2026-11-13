import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type FetchFailureKind,
  fetchWithTimeout,
  readResponseBody,
  trimResponseBody,
} from "./http";

class TestFetchError extends Error {
  readonly failure: unknown;
  readonly kind: FetchFailureKind;

  constructor(kind: FetchFailureKind, failure: unknown) {
    super(kind);
    this.kind = kind;
    this.failure = failure;
  }
}

function createTestError(kind: FetchFailureKind, failure: unknown): Error {
  return new TestFetchError(kind, failure);
}

async function catchTestError(
  promise: Promise<unknown>,
): Promise<TestFetchError> {
  try {
    await promise;
  } catch (error: unknown) {
    if (error instanceof TestFetchError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected the request to fail");
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchWithTimeout", () => {
  it("returns the response and passes the request through with a signal", async () => {
    const response = new Response("ok");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(
      fetchWithTimeout(
        "https://example.com/api",
        { method: "POST" },
        1_000,
        createTestError,
      ),
    ).resolves.toBe(response);

    const [input, init] = fetchSpy.mock.calls[0] ?? [];
    expect(input).toBe("https://example.com/api");
    expect(init?.method).toBe("POST");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports a request that fails before a response as request_failed", async () => {
    const failure = new TypeError("network down");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);

    const error = await catchTestError(
      fetchWithTimeout("https://example.com", {}, 1_000, createTestError),
    );

    expect(error.kind).toBe("request_failed");
    expect(error.failure).toBe(failure);
  });

  it("aborts the request at its deadline and reports request_timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const pending = catchTestError(
      fetchWithTimeout("https://example.com", {}, 5_000, createTestError),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await pending).kind).toBe("request_timeout");
  });

  it("clears the deadline once the response arrives", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));

    await fetchWithTimeout("https://example.com", {}, 5_000, createTestError);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("readResponseBody", () => {
  it("parses a JSON body", async () => {
    await expect(
      readResponseBody(new Response(JSON.stringify({ errorCode: "bad" }))),
    ).resolves.toEqual({ errorCode: "bad" });
  });

  it("keeps a non-JSON body as text", async () => {
    await expect(
      readResponseBody(new Response("Malformed SDP offer")),
    ).resolves.toBe("Malformed SDP offer");
  });

  it("returns null for an empty or unreadable body", async () => {
    const consumed = new Response("already read");
    await consumed.text();

    await expect(readResponseBody(new Response(null))).resolves.toBeNull();
    await expect(readResponseBody(consumed)).resolves.toBeNull();
  });
});

describe("trimResponseBody", () => {
  it("collapses whitespace and keeps the first 200 characters", () => {
    expect(trimResponseBody("  bad \n\t request  ")).toBe("bad request");
    expect(trimResponseBody("x".repeat(300))).toBe("x".repeat(200));
  });

  it("returns undefined for an empty or blank body", () => {
    expect(trimResponseBody("")).toBeUndefined();
    expect(trimResponseBody(" \n ")).toBeUndefined();
  });
});
