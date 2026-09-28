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

  it("handles a failed error-body read without losing the HTTP failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = new Response("bad gateway", { status: 502 });
    vi.spyOn(response, "text").mockRejectedValue(new Error("body unavailable"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(response);

    await expect(
      fetchTurnIceServers(new AbortController().signal),
    ).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      "TURN credential request failed:",
      expect.objectContaining({ responseText: undefined, status: 502 }),
    );
  });

  it("logs ordinary fetch failures and treats even abort-shaped non-Errors as failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const failure = { name: "AbortError" };
    vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);

    await expect(
      fetchTurnIceServers(new AbortController().signal),
    ).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      "Failed to fetch TURN credentials:",
      failure,
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

      // oxlint-disable vitest/no-conditional-expect -- The expected console call shape depends on the validation branch.
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
