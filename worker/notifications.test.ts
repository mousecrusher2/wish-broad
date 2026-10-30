import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteLiveStartedNotification,
  DiscordWebhookError,
  sendLiveStartedNotification,
} from "./notifications";

describe("worker live start notifications", () => {
  afterEach(() => {
    vi.useRealTimers();
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
    expect(result.error.name).toBe("DiscordWebhookError");
    expect(result.error).toMatchObject({
      endpoint: "https://discord.com/api/webhooks/123/token?wait=true",
      kind: "http_error",
      message: "Discord webhook request failed",
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
    expect(result.error.name).toBe("DiscordWebhookError");
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

  it("replaces an existing wait parameter and accepts integer message IDs", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ id: 42 }), { status: 200 }),
      );

    const result = await sendLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/123/token?wait=false&thread_id=7",
      },
      "user-1",
      "https://example.com/live",
    );

    expect(result._unsafeUnwrap()).toEqual({ messageId: 42n });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe(
      "https://discord.com/api/webhooks/123/token?wait=true&thread_id=7",
    );
  });

  it.each([
    ["not-json", "Discord webhook response was not valid JSON", "not-json"],
    ["{}", "Discord webhook response did not include a message id", "{}"],
    [
      '{"id":"not-a-number"}',
      "Discord webhook response did not include a valid message id",
      '{"id":"not-a-number"}',
    ],
  ])(
    "rejects invalid success body %s",
    async (body, message, responseBodyText) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body));

      const result = await sendLiveStartedNotification(
        {
          NOTIFICATIONS_DISCORD_WEBHOOK_URL:
            "https://discord.com/api/webhooks/1/token",
        },
        "user-1",
        "https://example.com",
      );

      expect(result.isErr()).toBe(true);
      if (result.isOk()) throw new Error("Expected invalid webhook result");
      expect(result.error).toMatchObject({
        kind: "http_error",
        message,
        responseBodyText,
      });
    },
  );

  it("normalizes trailing webhook path slashes when deleting a message", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 204 }));

    await deleteLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/1/token///?thread_id=3",
      },
      12345678901234567890n,
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://discord.com/api/webhooks/1/token/messages/12345678901234567890?thread_id=3",
      expect.objectContaining({ method: "DELETE" }),
    );
    expect(fetchSpy.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns a request_failed result when the webhook request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("offline"),
    );
    const networkError = await sendLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/1/token",
      },
      "user-1",
      "https://example.com",
    );
    expect(networkError.isErr()).toBe(true);
    if (networkError.isOk()) throw new Error("Expected request failure");
    expect(networkError.error).toMatchObject({
      kind: "request_failed",
      message: "Discord webhook request failed",
      responseBodyText: "offline",
    });
  });

  it("aborts webhook requests after five seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const pending = sendLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/1/token",
      },
      "user-1",
      "https://example.com",
    );
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected timeout");
    expect(result.error).toMatchObject({
      kind: "request_timeout",
      message: "Discord webhook request timed out",
    });
    vi.useRealTimers();
  });
});
