import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteLiveStartedNotification,
  DiscordWebhookError,
  sendLiveStartedNotification,
} from "./notifications";

describe("worker live start notifications", () => {
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
    expect(endpoint).toBe("https://discord.com/api/webhooks/123/token?wait=true");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
    });
    expect(typeof init?.body).toBe("string");
    if (typeof init?.body !== "string") {
      throw new Error("Expected webhook body to be a JSON string");
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
});
