import { err, ok, type Result } from "neverthrow";
import type { Bindings } from "./types";

type NotificationsEnv = Pick<Bindings, "NOTIFICATIONS_DISCORD_WEBHOOK_URL">;

const DISCORD_WEBHOOK_TIMEOUT_MS = 5_000;

type DiscordWebhookErrorKind =
  | "request_failed"
  | "request_timeout"
  | "http_error";

export class DiscordWebhookError extends Error {
  readonly endpoint: string;
  readonly kind: DiscordWebhookErrorKind;
  readonly responseBodyText: string | undefined;
  readonly statusText: string | undefined;

  constructor(
    message: string,
    options: {
      endpoint: string;
      kind: DiscordWebhookErrorKind;
      responseBodyText?: string | undefined;
      statusText?: string | undefined;
    },
  ) {
    super(message);
    this.name = "DiscordWebhookError";
    this.endpoint = options.endpoint;
    this.kind = options.kind;
    this.responseBodyText = options.responseBodyText;
    this.statusText = options.statusText;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return String(error);
}

function trimResponseBody(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }

  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.slice(0, 200);
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
  let pathname = url.pathname;
  while (pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  url.pathname = `${pathname}/messages/${messageId.toString()}`;
  return url.toString();
}

function parseMessageId(rawMessageId: unknown): bigint | null {
  if (typeof rawMessageId === "bigint") {
    return rawMessageId >= 0n ? rawMessageId : null;
  }

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

async function fetchDiscordWebhook(
  endpoint: string,
  init: RequestInit,
): Promise<Result<Response, DiscordWebhookError>> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, DISCORD_WEBHOOK_TIMEOUT_MS);

  return fetch(endpoint, {
    ...init,
    signal: abortController.signal,
  })
    .then((response) => ok(response))
    .catch((error: unknown) =>
      err(
        new DiscordWebhookError(
          isAbortError(error)
            ? "Discord webhook request timed out"
            : "Discord webhook request failed",
          {
            endpoint,
            kind: isAbortError(error) ? "request_timeout" : "request_failed",
            responseBodyText: getErrorMessage(error),
          },
        ),
      ),
    )
    .finally(() => {
      clearTimeout(timeoutId);
    });
}

export async function sendLiveStartedNotification(
  env: NotificationsEnv,
  userId: string,
  siteUrl: string,
): Promise<Result<{ messageId: bigint }, DiscordWebhookError>> {
  const endpoint = createWebhookExecutionEndpoint(
    env.NOTIFICATIONS_DISCORD_WEBHOOK_URL,
  );
  const responseResult = await fetchDiscordWebhook(endpoint, {
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

  if (responseResult.isErr()) {
    return err(responseResult.error);
  }

  const response = responseResult.value;
  const responseText = await response.text();
  if (!response.ok) {
    return err(
      new DiscordWebhookError("Discord webhook request failed", {
        endpoint,
        kind: "http_error",
        responseBodyText: trimResponseBody(responseText),
        statusText: response.statusText,
      }),
    );
  }

  let responseJson: unknown;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    return err(
      new DiscordWebhookError("Discord webhook response was not valid JSON", {
        endpoint,
        kind: "http_error",
        responseBodyText: trimResponseBody(responseText),
        statusText: response.statusText,
      }),
    );
  }

  if (
    typeof responseJson !== "object" ||
    responseJson === null ||
    !("id" in responseJson)
  ) {
    return err(
      new DiscordWebhookError(
        "Discord webhook response did not include a message id",
        {
          endpoint,
          kind: "http_error",
          responseBodyText: trimResponseBody(responseText),
          statusText: response.statusText,
        },
      ),
    );
  }

  const messageId = parseMessageId(responseJson.id);
  if (messageId === null) {
    return err(
      new DiscordWebhookError(
        "Discord webhook response did not include a valid message id",
        {
          endpoint,
          kind: "http_error",
          responseBodyText: trimResponseBody(responseText),
          statusText: response.statusText,
        },
      ),
    );
  }

  return ok({ messageId });
}

export async function deleteLiveStartedNotification(
  env: NotificationsEnv,
  messageId: bigint,
): Promise<Result<void, DiscordWebhookError>> {
  const endpoint = createWebhookMessageEndpoint(
    env.NOTIFICATIONS_DISCORD_WEBHOOK_URL,
    messageId,
  );
  const responseResult = await fetchDiscordWebhook(endpoint, {
    method: "DELETE",
  });

  if (responseResult.isErr()) {
    return err(responseResult.error);
  }

  const response = responseResult.value;
  if (response.ok) {
    return ok(undefined);
  }

  return err(
    new DiscordWebhookError("Discord webhook request failed", {
      endpoint,
      kind: "http_error",
      responseBodyText: trimResponseBody(await response.text()),
      statusText: response.statusText,
    }),
  );
}
