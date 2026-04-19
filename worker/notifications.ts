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

export async function sendLiveStartedNotification(
  env: NotificationsEnv,
  userId: string,
  siteUrl: string,
): Promise<Result<void, DiscordWebhookError>> {
  const endpoint = env.NOTIFICATIONS_DISCORD_WEBHOOK_URL;
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, DISCORD_WEBHOOK_TIMEOUT_MS);

  const responseResult = await fetch(endpoint, {
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
