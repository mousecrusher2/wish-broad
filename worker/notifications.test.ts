import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteLiveStartedNotification,
  DiscordWebhookError,
  sendLiveStartedNotification,
} from "./notifications";

describe("worker live start notifications", () => {
  const env = {
    NOTIFICATIONS_DISCORD_WEBHOOK_URL:
      "https://discord.com/api/webhooks/123/token",
  };
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a Discord webhook with a user mention and site url", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ id: "1" }), {
        status: 200,
      }),
    );

    const result = await sendLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/123/token",
      },
      "user-1",
      "https://example.com/",
    );

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual({ messageId: 1n });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [endpoint, init] = fetchSpy.mock.calls[0] ?? [];
    expect(endpoint).toBe(
      "https://discord.com/api/webhooks/123/token?wait=true",
    );
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(typeof init?.body).toBe("string");
    if (typeof init?.body !== "string") {
      throw new TypeError("Expected webhook body to be a JSON string");
    }
    expect(JSON.parse(init.body)).toEqual({
      allowed_mentions: {
        parse: [],
        users: ["user-1"],
      },
      content: "配信開始: <@user-1>\nhttps://example.com/",
    });
  });

  it("returns an http error result when Discord rejects the webhook", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("bad gateway", {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    const result = await sendLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/123/token",
      },
      "user-1",
      "https://example.com/",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected webhook request to fail");
    }

    expect(result.error).toBeInstanceOf(DiscordWebhookError);
    expect(result.error).toMatchObject({
      name: "DiscordWebhookError",
      message: "Discord webhook request failed",
      endpoint: "https://discord.com/api/webhooks/123/token?wait=true",
      kind: "http_error",
      responseBodyText: "bad gateway",
      statusText: "Bad Gateway",
    });
  });

  it("returns a timeout result when the webhook request is aborted", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation was aborted", "AbortError"),
    );

    const result = await sendLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/123/token",
      },
      "user-1",
      "https://example.com/",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected webhook request to fail");
    }

    expect(result.error).toBeInstanceOf(DiscordWebhookError);
    expect(result.error).toMatchObject({
      endpoint: "https://discord.com/api/webhooks/123/token?wait=true",
      kind: "request_timeout",
    });
  });

  it("deletes a Discord webhook message by id", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 204,
      }),
    );

    const result = await deleteLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/123/token",
      },
      1n,
    );

    expect(result.isOk()).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const [endpoint, init] = fetchSpy.mock.calls[0] ?? [];
    expect(endpoint).toBe(
      "https://discord.com/api/webhooks/123/token/messages/1",
    );
    expect(init?.method).toBe("DELETE");
  });

  it.each([
    ["0", 0n],
    [0, 0n],
    [12, 12n],
    ["9223372036854775808", 9223372036854775808n],
    [" 21 ", 21n],
  ])("accepts a valid webhook message id %s", async (id, expected) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id }));
    const result = await sendLiveStartedNotification(
      env,
      "member",
      "https://wish.test",
    );
    expect(result._unsafeUnwrap()).toEqual({ messageId: expected });
  });

  it.each([null, false, {}, [], "", "bad", "-1", -1, 0.5])(
    "rejects malformed webhook message id %s",
    async (id) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id }));
      const result = await sendLiveStartedNotification(
        env,
        "member",
        "https://wish.test",
      );
      expect(result._unsafeUnwrapErr()).toMatchObject({
        kind: "http_error",
        message: "Discord webhook response did not include a valid message id",
      });
    },
  );

  it.each(["{}", "null", "[]", "false"])(
    "rejects a webhook response missing an ID (%s)",
    async (body) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));
      const result = await sendLiveStartedNotification(
        env,
        "member",
        "https://wish.test",
      );
      expect(result._unsafeUnwrapErr()).toMatchObject({
        kind: "http_error",
        message: "Discord webhook response did not include a message id",
        responseBodyText: body,
      });
    },
  );

  it("rejects invalid JSON from a successful webhook response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("not json", { status: 200 }),
    );
    const result = await sendLiveStartedNotification(
      env,
      "member",
      "https://wish.test",
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "http_error",
      message: "Discord webhook response was not valid JSON",
      responseBodyText: "not json",
    });
  });

  it("normalizes and truncates an upstream error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(` \n  ${"x".repeat(250)}  \t`, {
        status: 429,
        statusText: "Too Many Requests",
      }),
    );
    const result = await sendLiveStartedNotification(
      env,
      "member",
      "https://wish.test",
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "http_error",
      responseBodyText: "x".repeat(200),
      statusText: "Too Many Requests",
    });
  });

  it("does not attach an empty upstream body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(" \n\t ", { status: 500 }),
    );
    const result = await sendLiveStartedNotification(
      env,
      "member",
      "https://wish.test",
    );
    expect(result._unsafeUnwrapErr().responseBodyText).toBeUndefined();
  });

  it.each([
    [new Error("offline"), "request_failed", "offline"],
    ["offline", "request_failed", "offline"],
    [new Error(" "), "request_failed", "Error:  "],
    [new DOMException("aborted", "AbortError"), "request_timeout", "aborted"],
  ])("classifies webhook transport failure %s", async (failure, kind, body) => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(failure);
    const result = await sendLiveStartedNotification(
      env,
      "member",
      "https://wish.test",
    );
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind,
      message:
        kind === "request_timeout"
          ? "Discord webhook request timed out"
          : "Discord webhook request failed",
      responseBodyText: body,
    });
  });

  it("preserves an existing webhook query while adding wait=true", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ id: "7" }));
    const result = await sendLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL: `${env.NOTIFICATIONS_DISCORD_WEBHOOK_URL}?wait=false&thread_id=4`,
      },
      "member",
      "https://wish.test",
    );
    expect(result._unsafeUnwrap()).toEqual({ messageId: 7n });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://discord.com/api/webhooks/123/token?wait=true&thread_id=4",
    );
  });

  it("removes trailing slashes from the webhook URL for message deletion", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));
    const result = await deleteLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL: `${env.NOTIFICATIONS_DISCORD_WEBHOOK_URL}///?thread_id=4`,
      },
      42n,
    );
    expect(result.isOk()).toBe(true);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://discord.com/api/webhooks/123/token/messages/42?thread_id=4",
    );
  });

  it("reports a failed webhook message deletion with its endpoint and response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("  missing \n now  ", {
        status: 404,
        statusText: "Not Found",
      }),
    );
    const result = await deleteLiveStartedNotification(env, 42n);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      endpoint: `${env.NOTIFICATIONS_DISCORD_WEBHOOK_URL}/messages/42`,
      kind: "http_error",
      responseBodyText: "missing now",
      statusText: "Not Found",
    });
  });

  it("reports DELETE transport failure without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const result = await deleteLiveStartedNotification(env, 42n);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "request_failed",
      responseBodyText: "offline",
      endpoint: `${env.NOTIFICATIONS_DISCORD_WEBHOOK_URL}/messages/42`,
    });
  });

  it("aborts a hanging webhook request after five seconds", async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
        (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("aborted by timeout", "AbortError"));
            });
          }),
      );
      const resultPromise = sendLiveStartedNotification(
        env,
        "member",
        "https://wish.test",
      );
      await vi.advanceTimersByTimeAsync(4_999);
      expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect((await resultPromise)._unsafeUnwrapErr()).toMatchObject({
        kind: "request_timeout",
        message: "Discord webhook request timed out",
        responseBodyText: "aborted by timeout",
      });
      expect(fetchSpy.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not attach an empty response body to DELETE failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("", { status: 500 }),
    );
    const result = await deleteLiveStartedNotification(env, 42n);
    expect(result._unsafeUnwrapErr()).toMatchObject({
      kind: "http_error",
      message: "Discord webhook request failed",
      responseBodyText: undefined,
    });
  });
});
