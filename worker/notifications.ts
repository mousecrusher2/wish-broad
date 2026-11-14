import { fetchWithTimeout, trimResponseBody } from "./http";
import type { Bindings } from "./types";

type NotificationsEnv = Pick<Bindings, "NOTIFICATIONS_DISCORD_WEBHOOK_URL">;

const DISCORD_WEBHOOK_TIMEOUT_MS = 5_000;

type DiscordWebhookErrorKind =
  "request_failed" | "request_timeout" | "http_error";

const REDACTED = "[redacted]";

/**
 * Webhook URL の token 部分を伏字にする。URL の形式は `/api[/vN]/webhooks/{id}/{token}[/...]`
 * で、token だけでチャンネルへの投稿と削除ができる。エラーログにはエンドポイントが記録される
 * ため、ログには必ずこの形式だけを含める。
 */
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

  /** 同じリクエストを後で再送した場合に成功する可能性があるかどうか。 */
  isRetryable(): boolean {
    if (this.kind !== "http_error") {
      // Discord の応答前にリクエストが失敗またはタイムアウトした。
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
  // 配信の終了時に開始通知を削除するにはメッセージ ID が必要で、wait=true のときだけ返される。
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
 * @throws {DiscordWebhookError} Discord の応答前にリクエストが失敗またはタイムアウトした場合。
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
 * 配信開始メッセージを Discord Webhook に投稿する。
 *
 * @returns 投稿されたメッセージ ID（後で削除する際に必要）。
 * @throws {DiscordWebhookError} リクエストに失敗したか、Discord に拒否されたか、
 * レスポンスに有効なメッセージ ID が含まれていなかった場合。
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
 * 以前に投稿した配信開始メッセージを削除する。
 *
 * @throws {DiscordWebhookError} リクエストに失敗したか Discord に拒否された場合。
 * 後で再試行すれば成功する可能性があるかは `isRetryable()` で判定できる。
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
