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
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("/api/turn-credentials");
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

  it("returns null and logs the response details on an HTTP error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("upstream down", { status: 503, statusText: "Unavailable" }),
    );
    expect(await fetchTurnIceServers(new AbortController().signal)).toBeNull();
    expect(warn).toHaveBeenCalledWith("TURN credential request failed:", {
      responseText: "upstream down",
      status: 503,
      statusText: "Unavailable",
    });
  });

  it("fails open after a non-abort network error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = new Error("offline");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(error);
    expect(await fetchTurnIceServers(new AbortController().signal)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "Failed to fetch TURN credentials:",
      error,
    );
  });

  it("reports malformed JSON, invalid schema, and an empty ICE server list", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy.mockResolvedValueOnce(new Response("{"));
    expect(await fetchTurnIceServers(new AbortController().signal)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "TURN credential response was not valid JSON:",
      expect.any(SyntaxError),
    );
    expect(warn).toHaveBeenCalledTimes(1);

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ iceServers: [{ urls: 42 }] })),
    );
    expect(await fetchTurnIceServers(new AbortController().signal)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "TURN credential response schema was invalid:",
      expect.objectContaining({ responseBody: { iceServers: [{ urls: 42 }] } }),
    );

    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ iceServers: [] })),
    );
    expect(await fetchTurnIceServers(new AbortController().signal)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      "TURN credential response did not contain any ICE servers",
    );
  });

  it("retains optional credentials for nonempty values and omits absent values", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          iceServers: [
            {
              urls: "turn:example.net",
              username: "alice",
              credential: "secret",
            },
            { urls: ["stun:example.net"], username: "", credential: "" },
          ],
        }),
      ),
    );
    expect(await fetchTurnIceServers(new AbortController().signal)).toEqual([
      { urls: "turn:example.net", username: "alice", credential: "secret" },
      { urls: ["stun:example.net"] },
    ]);
  });
});
