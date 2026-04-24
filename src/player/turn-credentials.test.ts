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
    const [, init] = fetchSpy.mock.calls[0] ?? [];
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(init).toMatchObject({
      credentials: "include",
      headers: {
        Accept: "application/json",
      },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("fails open when the worker endpoint rejects the request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad gateway", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    const result = await fetchTurnIceServers(new AbortController().signal);

    expect(result).toBeNull();
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
});
