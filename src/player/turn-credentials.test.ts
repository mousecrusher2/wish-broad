import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTurnIceServers } from "./turn-credentials";

describe("turn-credentials", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns ICE servers from the authenticated worker endpoint", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [
            {
              urls: ["stun:stun.cloudflare.com:3478"],
            },
          ],
        }),
        {
          status: 200,
        },
      ),
    );

    const result = await fetchTurnIceServers(new AbortController().signal);

    expect(result).toEqual([
      {
        urls: ["stun:stun.cloudflare.com:3478"],
      },
    ]);
    const [url, init] = fetchSpy.mock.calls[0] ?? [];
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(url).toBe("/api/turn-credentials");
    expect(init?.credentials).toBe("include");
    expect(init?.headers).toEqual({ Accept: "application/json" });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails open when the worker endpoint rejects the request", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad gateway", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    const result = await fetchTurnIceServers(new AbortController().signal);

    expect(result).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "TURN credential request failed:",
      expect.objectContaining({ status: 502, statusText: "Bad Gateway" }),
    );
  });

  it("does not rethrow ordinary Error instances", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));

    await expect(
      fetchTurnIceServers(new AbortController().signal),
    ).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      "Failed to fetch TURN credentials:",
      expect.objectContaining({ message: "offline" }),
    );
  });

  it("gives up after 8 seconds without a response and continues without TURN", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("abort"),
            );
          });
        }),
    );

    const pending = fetchTurnIceServers(new AbortController().signal);
    expect(timeoutSpy).toHaveBeenCalledExactlyOnceWith(8_000);
    timeout.abort(new DOMException("signal timed out", "TimeoutError"));

    await expect(pending).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "Failed to fetch TURN credentials:",
      expect.objectContaining({ name: "TimeoutError" }),
    );
  });

  it("rethrows aborts so session disposal can stop startup", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    await expect(
      fetchTurnIceServers(new AbortController().signal),
    ).rejects.toMatchObject({
      name: "AbortError",
    });
  });

  it("fails open when the successful response contains invalid JSON", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not-json", { status: 200 }),
    );

    await expect(
      fetchTurnIceServers(new AbortController().signal),
    ).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      "TURN credential response was not valid JSON:",
      expect.any(SyntaxError),
    );
  });

  it.each([
    [null, null],
    [{}, "TURN credential response schema was invalid:"],
    [
      { iceServers: [] },
      "TURN credential response did not contain any ICE servers",
    ],
    [
      { iceServers: [{ urls: 42 }] },
      "TURN credential response schema was invalid:",
    ],
    [
      { iceServers: [{ urls: "turn:example", username: 7 }] },
      "TURN credential response schema was invalid:",
    ],
  ] as const)(
    "rejects invalid TURN response shapes: %j",
    async (body, warning) => {
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(body), { status: 200 }),
      );

      await expect(
        fetchTurnIceServers(new AbortController().signal),
      ).resolves.toBeNull();

      // oxlint-disable vitest/no-conditional-expect -- 期待される console 呼び出しの形式が検証分岐によって異なるため。
      if (warning === null) {
        expect(warn).not.toHaveBeenCalled();
      } else if (warning.endsWith(":")) {
        expect(warn).toHaveBeenCalledWith(
          warning,
          expect.objectContaining({ responseBody: body }),
        );
      } else {
        expect(warn).toHaveBeenCalledWith(warning);
      }
      // oxlint-enable vitest/no-conditional-expect
    },
  );

  it("normalizes string URLs and only includes non-empty optional credentials", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [
            { urls: "stun:example.test" },
            { credential: "", urls: ["turn:example.test"], username: "" },
            {
              credential: "secret",
              urls: "turns:example.test",
              username: "alice",
            },
          ],
        }),
        { status: 200 },
      ),
    );

    await expect(
      fetchTurnIceServers(new AbortController().signal),
    ).resolves.toEqual([
      { urls: "stun:example.test" },
      { urls: ["turn:example.test"] },
      { credential: "secret", urls: "turns:example.test", username: "alice" },
    ]);
  });
});
