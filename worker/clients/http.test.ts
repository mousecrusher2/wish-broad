import { afterEach, assert, describe, expect, it, vi } from "vitest";
import {
  FetchError,
  fetchWithTimeout,
  parseResponseBody,
  trimResponseBody,
} from "./http";

async function catchFetchError(promise: Promise<unknown>): Promise<FetchError> {
  const error = await promise.then(
    () => undefined,
    (rejection: unknown) => rejection,
  );
  assert.instanceOf(error, FetchError);
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
      fetchWithTimeout("https://example.com/api", { method: "POST" }, 1_000),
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

    const error = await catchFetchError(
      fetchWithTimeout("https://example.com", {}, 1_000),
    );

    expect(error.kind).toBe("request_failed");
    expect(error.cause).toBe(failure);
  });

  it("aborts the request at its timeout and reports request_timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const pending = catchFetchError(
      fetchWithTimeout("https://example.com", {}, 5_000),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);

    expect((await pending).kind).toBe("request_timeout");
  });

  it("reports a body read stopped by the timeout as request_timeout", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              // 実行環境が中断で本文の読み取りを止めた場合を再現する。
              init?.signal?.addEventListener("abort", () => {
                controller.error(new DOMException("aborted", "AbortError"));
              });
            },
          }),
        ),
      ),
    );

    const pending = catchFetchError(
      fetchWithTimeout("https://example.com", {}, 5_000),
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

    const error = await catchFetchError(
      fetchWithTimeout("https://example.com", {}, 1_000),
    );

    expect(error.kind).toBe("request_failed");
  });

  it("clears the timeout once the body has been read", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("done"));

    await fetchWithTimeout("https://example.com", {}, 5_000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the request when its deadline is aborted before the timeout", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const deadline = new AbortController();

    const pending = catchFetchError(
      fetchWithTimeout("https://example.com", {}, 5_000, deadline.signal),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    deadline.abort();

    expect((await pending).kind).toBe("request_timeout");
    expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the timeout when the deadline is later", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );

    const pending = catchFetchError(
      fetchWithTimeout(
        "https://example.com",
        {},
        5_000,
        new AbortController().signal,
      ),
    );
    await vi.advanceTimersByTimeAsync(5_000);

    expect((await pending).kind).toBe("request_timeout");
  });

  it("does not send the request once its deadline has been aborted", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const error = await catchFetchError(
      fetchWithTimeout("https://example.com", {}, 5_000, AbortSignal.abort()),
    );

    expect(error.kind).toBe("request_timeout");
    expect(fetchSpy).not.toHaveBeenCalled();
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
