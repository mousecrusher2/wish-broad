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

  it.each([0, "0"])(
    "accepts zero as a valid decimal message id (%j)",
    async (id) => {
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ id }), { status: 200 }),
      );

      await expect(
        sendLiveStartedNotification(
          {
            NOTIFICATIONS_DISCORD_WEBHOOK_URL:
              "https://discord.com/api/webhooks/1/token",
          },
          "user-1",
          "https://example.com",
        ),
      ).resolves.toMatchObject({ value: { messageId: 0n } });
    },
  );

  it.each([
    ["not-json", "Discord webhook response was not valid JSON", "not-json"],
    ["{}", "Discord webhook response did not include a message id", "{}"],
    ["null", "Discord webhook response did not include a message id", "null"],
    ["true", "Discord webhook response did not include a message id", "true"],
    ["42", "Discord webhook response did not include a message id", "42"],
    ["[]", "Discord webhook response did not include a message id", "[]"],
    [
      '{"id":-1}',
      "Discord webhook response did not include a valid message id",
      '{"id":-1}',
    ],
    [
      '{"id":1.5}',
      "Discord webhook response did not include a valid message id",
      '{"id":1.5}',
    ],
    [
      '{"id":""}',
      "Discord webhook response did not include a valid message id",
      '{"id":""}',
    ],
    [
      '{"id":"not-a-number"}',
      "Discord webhook response did not include a valid message id",
      '{"id":"not-a-number"}',
    ],
    [
      '{"id":"-1"}',
      "Discord webhook response did not include a valid message id",
      '{"id":"-1"}',
    ],
    [
      '{"id":null}',
      "Discord webhook response did not include a valid message id",
      '{"id":null}',
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

  it("trims blank and caps long error bodies for both webhook methods", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(" \n\t ", { status: 400, statusText: "Bad Request" }),
    );
    const blank = await sendLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/1/token",
      },
      "user-1",
      "https://example.com",
    );
    expect(blank.isErr()).toBe(true);
    if (blank.isOk()) throw new Error("Expected webhook failure");
    expect(blank.error.responseBodyText).toBeUndefined();

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("y ".repeat(150), {
        status: 502,
        statusText: "Bad Gateway",
      }),
    );
    const deleted = await deleteLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/1/token",
      },
      17n,
    );
    expect(deleted.isErr()).toBe(true);
    if (deleted.isOk()) throw new Error("Expected delete failure");
    expect(deleted.error.responseBodyText).toBe("y ".repeat(100));
    expect(deleted.error.statusText).toBe("Bad Gateway");
    expect(deleted.error.message).toBe("Discord webhook request failed");
    expect(deleted.error.kind).toBe("http_error");
  });

  it("collapses multiline HTTP failure bodies to a single space", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(" first\n\t second   line ", {
        status: 400,
        statusText: "Bad Request",
      }),
    );

    const result = await sendLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/1/token",
      },
      "user-1",
      "https://example.com",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) throw new Error("Expected webhook failure");
    expect(result.error.responseBodyText).toBe("first second line");
    expect(result.error.statusText).toBe("Bad Request");
  });

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

  it("returns a request_failed result for ordinary and non-Error rejections", async () => {
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

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue("offline string");
    const stringError = await deleteLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/1/token",
      },
      2n,
    );
    expect(stringError.isErr()).toBe(true);
    if (stringError.isOk()) throw new Error("Expected request failure");
    expect(stringError.error.responseBodyText).toBe("offline string");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error(""));
    const emptyError = await deleteLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/1/token",
      },
      3n,
    );
    expect(emptyError.isErr()).toBe(true);
    if (emptyError.isOk()) throw new Error("Expected empty network error");
    expect(emptyError.error.responseBodyText).toBe("Error");

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("   "));
    const whitespaceError = await deleteLiveStartedNotification(
      {
        NOTIFICATIONS_DISCORD_WEBHOOK_URL:
          "https://discord.com/api/webhooks/1/token",
      },
      4n,
    );
    expect(whitespaceError.isErr()).toBe(true);
    if (whitespaceError.isOk()) {
      throw new Error("Expected whitespace network error");
    }
    expect(whitespaceError.error.responseBodyText).toBe("Error:    ");
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

  it("clears the timeout after a fast webhook response", async () => {
    vi.useFakeTimers();
    const requestSignals: (AbortSignal | null)[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      requestSignals.push(init?.signal ?? null);
      return Promise.resolve(new Response(JSON.stringify({ id: "12" })));
    });

    await expect(
      sendLiveStartedNotification(
        {
          NOTIFICATIONS_DISCORD_WEBHOOK_URL:
            "https://discord.com/api/webhooks/1/token",
        },
        "user-1",
        "https://example.com",
      ),
    ).resolves.toMatchObject({ value: { messageId: 12n } });

    expect(requestSignals).toHaveLength(1);
    expect(requestSignals[0]).toBeInstanceOf(AbortSignal);
    expect(requestSignals[0]).toMatchObject({ aborted: false });
    expect(vi.getTimerCount()).toBe(0);
  });
});
