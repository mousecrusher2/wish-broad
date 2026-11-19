import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  type FetchFailureKind,
  fetchWithTimeout,
  parseResponseBody,
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
  const error = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  assert.instanceOf(error, TestFetchError);
  return error;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("fetchWithTimeout", () => {
  it("returns the status and the whole body and passes the request through with a signal", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("ok", { status: 201, statusText: "Created" }),
      );

    await expect(
      fetchWithTimeout(
        "https://example.com/api",
        { method: "POST" },
        1_000,
        createTestError,
      ),
    ).resolves.toEqual({
      bodyText: "ok",
      ok: true,
      status: 201,
      statusText: "Created",
    });

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

  it("times out a response whose body never finishes", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
          },
        }),
      ),
    );

    const pending = catchTestError(
      fetchWithTimeout("https://example.com", {}, 5_000, createTestError),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await pending).kind).toBe("request_timeout");
  });

  it("reports a body that fails while being read as request_failed", async () => {
    const failure = new TypeError("connection reset");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(failure);
          },
        }),
      ),
    );

    const error = await catchTestError(
      fetchWithTimeout("https://example.com", {}, 1_000, createTestError),
    );

    expect(error.kind).toBe("request_failed");
  });

  it("clears the deadline once the body has been read", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("done"));

    await fetchWithTimeout("https://example.com", {}, 5_000, createTestError);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("parseResponseBody", () => {
  it("parses a JSON body", () => {
    expect(parseResponseBody(JSON.stringify({ errorCode: "bad" }))).toEqual({
      errorCode: "bad",
    });
  });

  it("keeps a non-JSON body as text", () => {
    expect(parseResponseBody("Malformed SDP offer")).toBe(
      "Malformed SDP offer",
    );
  });

  it("returns null for an empty body", () => {
    expect(parseResponseBody("")).toBeNull();
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
