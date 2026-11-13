import { fetchWithTimeout, trimResponseBody } from "./http";
import type { Bindings } from "./types";

type NotificationsEnv = Pick<Bindings, "NOTIFICATIONS_DISCORD_WEBHOOK_URL">;

const DISCORD_WEBHOOK_TIMEOUT_MS = 5_000;

type DiscordWebhookErrorKind =
  "request_failed" | "request_timeout" | "http_error";

const REDACTED = "[redacted]";

// Discord webhook URLs are `/api[/vN]/webhooks/{id}/{token}[/...]`, and the
// token alone authorizes posting and deleting channel messages. Errors are
// logged with their endpoint, so they only ever carry this redacted form.
function redactWebhookUrl(webhookUrl: string): string {
  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return REDACTED;
  }

  const segments = url.pathname.split("/");
  const tokenIndex = segments.indexOf("webhooks") + 2;
  if (tokenIndex < 2 || tokenIndex >= segments.length) {
    return `${url.origin}/${REDACTED}`;
  }

  segments[tokenIndex] = REDACTED;
  return `${url.origin}${segments.join("/")}${url.search}`;
}

export class DiscordWebhookError extends Error {
  readonly endpoint: string;
  readonly kind: DiscordWebhookErrorKind;
  readonly responseBodyText: string | undefined;
  readonly status: number | undefined;
  readonly statusText: string | undefined;

  constructor(
    message: string,
    options: {
      endpoint: string;
      kind: DiscordWebhookErrorKind;
      responseBodyText?: string | undefined;
      status?: number | undefined;
      statusText?: string | undefined;
    },
  ) {
    super(message);
    this.name = "DiscordWebhookError";
    this.endpoint = redactWebhookUrl(options.endpoint);
    this.kind = options.kind;
    this.responseBodyText = options.responseBodyText;
    this.status = options.status;
    this.statusText = options.statusText;
  }

  /** Whether sending the same request again later could succeed. */
  isRetryable(): boolean {
    if (this.kind !== "http_error") {
      // The request failed or timed out before Discord answered.
      return true;
    }

    return (
      this.status !== undefined && (this.status === 429 || this.status >= 500)
    );
  }
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

function createWebhookExecutionEndpoint(webhookUrl: string): string {
  const url = new URL(webhookUrl);
  // wait=true is required because the returned message id is what lets us delete
  // best-effort start notifications when the matching live row is removed.
  url.searchParams.set("wait", "true");
  return url.toString();
}

function createWebhookMessageEndpoint(
  webhookUrl: string,
  messageId: bigint,
): string {
  const url = new URL(webhookUrl);
  const pathname = url.pathname.replace(/\/+$/u, "");
  url.pathname = `${pathname}/messages/${messageId.toString()}`;
  return url.toString();
}

function parseMessageId(rawMessageId: unknown): bigint | null {
  if (typeof rawMessageId === "number") {
    if (!Number.isInteger(rawMessageId) || rawMessageId < 0) {
      return null;
    }

    return BigInt(rawMessageId);
  }

  if (typeof rawMessageId !== "string" || rawMessageId.length === 0) {
    return null;
  }

  try {
    const messageId = BigInt(rawMessageId);
    return messageId >= 0n ? messageId : null;
  } catch {
    return null;
  }
}

/**
 * @throws {DiscordWebhookError} When the request fails or times out before
 * Discord answers.
 */
async function fetchDiscordWebhook(
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  return fetchWithTimeout(
    endpoint,
    init,
    DISCORD_WEBHOOK_TIMEOUT_MS,
    (kind, error) =>
      new DiscordWebhookError(
        kind === "request_timeout"
          ? "Discord webhook request timed out"
          : "Discord webhook request failed",
        { endpoint, kind, responseBodyText: getErrorMessage(error) },
      ),
  );
}

/**
 * Post the live start message to the Discord webhook.
 *
 * @returns The posted message id, which is needed to delete it later.
 * @throws {DiscordWebhookError} When the request fails, Discord rejects it, or
 * the response does not carry a valid message id.
 */
export async function sendLiveStartedNotification(
  env: NotificationsEnv,
  userId: string,
  siteUrl: string,
): Promise<{ messageId: bigint }> {
  const endpoint = createWebhookExecutionEndpoint(
    env.NOTIFICATIONS_DISCORD_WEBHOOK_URL,
  );
  const response = await fetchDiscordWebhook(endpoint, {
    body: JSON.stringify({
      allowed_mentions: {
        parse: [],
        users: [userId],
      },
      content: `配信開始: <@${userId}>\n${siteUrl}`,
    }),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const responseText = await response.text();
  if (!response.ok) {
    throw new DiscordWebhookError("Discord webhook request failed", {
      endpoint,
      kind: "http_error",
      responseBodyText: trimResponseBody(responseText),
      status: response.status,
      statusText: response.statusText,
    });
  }

  let responseJson: unknown;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    throw new DiscordWebhookError(
      "Discord webhook response was not valid JSON",
      {
        endpoint,
        kind: "http_error",
        responseBodyText: trimResponseBody(responseText),
        statusText: response.statusText,
      },
    );
  }

  if (
    typeof responseJson !== "object" ||
    responseJson === null ||
    !("id" in responseJson)
  ) {
    throw new DiscordWebhookError(
      "Discord webhook response did not include a message id",
      {
        endpoint,
        kind: "http_error",
        responseBodyText: trimResponseBody(responseText),
        statusText: response.statusText,
      },
    );
  }

  const messageId = parseMessageId(responseJson.id);
  if (messageId === null) {
    throw new DiscordWebhookError(
      "Discord webhook response did not include a valid message id",
      {
        endpoint,
        kind: "http_error",
        responseBodyText: trimResponseBody(responseText),
        statusText: response.statusText,
      },
    );
  }

  return { messageId };
}

/**
 * Delete a previously posted live start message.
 *
 * @throws {DiscordWebhookError} When the request fails or Discord rejects it;
 * `isRetryable()` tells whether trying again later could succeed.
 */
export async function deleteLiveStartedNotification(
  env: NotificationsEnv,
  messageId: bigint,
): Promise<void> {
  const endpoint = createWebhookMessageEndpoint(
    env.NOTIFICATIONS_DISCORD_WEBHOOK_URL,
    messageId,
  );
  const response = await fetchDiscordWebhook(endpoint, {
    method: "DELETE",
  });
  if (response.ok) {
    return;
  }

  throw new DiscordWebhookError("Discord webhook request failed", {
    endpoint,
    kind: "http_error",
    responseBodyText: trimResponseBody(await response.text()),
    status: response.status,
    statusText: response.statusText,
  });
}
