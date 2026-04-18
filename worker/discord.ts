import { Bindings } from "./types";
import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";

type DiscordEnv = Pick<Bindings, "DISCORD_CLIENT_ID" | "DISCORD_CLIENT_SECRET">;

const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export type DiscordUser = {
  id: string;
  username: string;
  discriminator?: string | null | undefined;
  global_name?: string | null | undefined;
};

export type DiscordGuildMember = {
  user: DiscordUser;
  nick?: string | null | undefined;
};

export type DiscordOAuthToken = {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
  refreshToken?: string | undefined;
};

const DISCORD_OAUTH_SCOPES = [
  "identify",
  "guilds.members.read",
] satisfies readonly [string, string];

export const DISCORD_STATE_COOKIE_NAME = "discord_oauth_state";
export const DISCORD_STATE_MAX_AGE_SECONDS = 60 * 10;
const DISCORD_FETCH_TIMEOUT_MS = 10_000;

type DiscordApiErrorKind =
  | "request_failed"
  | "request_timeout"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "http_error"
  | "non_json_response"
  | "unexpected_json_response";

const discordHttpKindMessage: Partial<Record<DiscordApiErrorKind, string>> = {
  forbidden: "Forbidden",
  not_found: "Not Found",
  rate_limited: "Too Many Requests",
  unauthorized: "Unauthorized",
};

export class DiscordApiError extends Error {
  readonly endpoint: string;
  readonly kind: DiscordApiErrorKind;
  readonly responseBodyJson: unknown;
  readonly responseBodyText: string | undefined;
  readonly statusText: string | undefined;

  constructor(
    message: string,
    options: {
      endpoint: string;
      kind: DiscordApiErrorKind;
      statusText?: string | undefined;
      responseBodyText?: string | undefined;
      responseBodyJson?: unknown;
    },
  ) {
    super(message);
    this.name = "DiscordApiError";
    this.endpoint = options.endpoint;
    this.kind = options.kind;
    this.statusText = options.statusText;
    this.responseBodyText = options.responseBodyText;
    this.responseBodyJson = options.responseBodyJson;
  }

  static fromHttpFailure(
    status: number,
    statusText: string,
    endpoint: string,
    responseBodyText?: string,
    responseBodyJson?: unknown,
  ): DiscordApiError {
    if (status === 401) {
      return new DiscordApiError("Discord request failed: unauthorized", {
        endpoint,
        kind: "unauthorized",
        statusText,
        responseBodyText,
        responseBodyJson,
      });
    }
    if (status === 403) {
      return new DiscordApiError("Discord request failed: forbidden", {
        endpoint,
        kind: "forbidden",
        statusText,
        responseBodyText,
        responseBodyJson,
      });
    }
    if (status === 404) {
      return new DiscordApiError("Discord request failed: not found", {
        endpoint,
        kind: "not_found",
        statusText,
        responseBodyText,
        responseBodyJson,
      });
    }
    if (status === 429) {
      return new DiscordApiError("Discord request failed: rate limited", {
        endpoint,
        kind: "rate_limited",
        statusText,
        responseBodyText,
        responseBodyJson,
      });
    }

    return new DiscordApiError("Discord request failed", {
      endpoint,
      kind: "http_error",
      statusText,
      responseBodyText,
      responseBodyJson,
    });
  }
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

function looksLikeHtml(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  return (
    normalized.startsWith("<!doctype html") ||
    normalized.startsWith("<html") ||
    normalized.startsWith("<body") ||
    normalized.startsWith("<")
  );
}

function createDiscordBasicAuthHeader(env: DiscordEnv): string {
  const credentials = `${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`;
  return `Basic ${btoa(credentials)}`;
}

function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}

async function fetchDiscordWithTimeout(
  endpoint: string,
  init: RequestInit,
): Promise<Result<Response, DiscordApiError>> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, DISCORD_FETCH_TIMEOUT_MS);

  return fetch(endpoint, {
    ...init,
    signal: abortController.signal,
  })
    .then((response) => ok(response))
    .catch((error: Error) =>
      err(
        new DiscordApiError(
          isAbortError(error)
            ? "Discord request timed out"
            : error.message,
          {
            endpoint,
            kind: isAbortError(error) ? "request_timeout" : "request_failed",
          },
        ),
      ),
    )
    .finally(() => {
      clearTimeout(timeoutId);
    });
}

async function fetchDiscordJson<TInput, TOutput>(
  endpoint: string,
  init: RequestInit,
  schema: v.GenericSchema<unknown, TInput>,
  mapParsed: (parsed: TInput) => TOutput,
): Promise<Result<TOutput, DiscordApiError>> {
  const responseResult = await fetchDiscordWithTimeout(endpoint, init);
  if (responseResult.isErr()) {
    return err(responseResult.error);
  }
  const response = responseResult.value;
  const responseText = await response.text();
  let responseJson: unknown = undefined;
  if (responseText.trim().length > 0) {
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = undefined;
    }
  }

  if (!response.ok) {
    return err(
      DiscordApiError.fromHttpFailure(
        response.status,
        response.statusText,
        endpoint,
        trimResponseBody(responseText),
        responseJson,
      ),
    );
  }

  if (responseJson === undefined) {
    return err(
      new DiscordApiError("Discord returned a non-JSON response", {
        endpoint,
        kind: "non_json_response",
        statusText: response.statusText,
        responseBodyText: trimResponseBody(responseText),
        responseBodyJson: responseJson,
      }),
    );
  }

  const parsedBody = v.safeParse(schema, responseJson);
  if (!parsedBody.success) {
    return err(
      new DiscordApiError("Discord returned an unexpected JSON response", {
        endpoint,
        kind: "unexpected_json_response",
        statusText: response.statusText,
        responseBodyText: trimResponseBody(responseText),
        responseBodyJson: responseJson,
      }),
    );
  }

  return ok(mapParsed(parsedBody.output));
}

async function fetchDiscord(
  endpoint: string,
  init: RequestInit,
): Promise<Result<Response, DiscordApiError>> {
  return fetchDiscordWithTimeout(endpoint, init);
}

export function createOAuthState(): string {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  return Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function buildDiscordAuthorizationUrl(
  env: Pick<Bindings, "DISCORD_CLIENT_ID">,
  redirectUri: string,
  state: string,
): string {
  const url = new URL(DISCORD_AUTHORIZE_URL);
  url.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", DISCORD_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeCodeForToken(
  env: DiscordEnv,
  code: string,
  redirectUri: string,
): Promise<Result<DiscordOAuthToken, DiscordApiError>> {
  const discordOAuthTokenResponseSchema = v.object({
    access_token: v.string(),
    token_type: v.string(),
    expires_in: v.number(),
    refresh_token: v.optional(v.string()),
    scope: v.string(),
  });
  const tokenEndpoint = `${DISCORD_API_BASE_URL}/oauth2/token`;

  return fetchDiscordJson(
    tokenEndpoint,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: createDiscordBasicAuthHeader(env),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    },
    discordOAuthTokenResponseSchema,
    (parsedToken) => ({
      accessToken: parsedToken.access_token,
      expiresIn: parsedToken.expires_in,
      refreshToken: parsedToken.refresh_token,
      scope: parsedToken.scope,
      tokenType: parsedToken.token_type,
    }),
  );
}

export async function getGuildMember(
  accessToken: string,
  guildId: string,
): Promise<Result<DiscordGuildMember, DiscordApiError>> {
  const discordUserSchema = v.object({
    id: v.string(),
    username: v.string(),
    discriminator: v.optional(v.nullish(v.string())),
    global_name: v.optional(v.nullish(v.string())),
  });
  const discordGuildMemberSchema = v.object({
    user: discordUserSchema,
    nick: v.optional(v.nullish(v.string())),
  });

  return fetchDiscordJson(
    `${DISCORD_API_BASE_URL}/users/@me/guilds/${encodeURIComponent(guildId)}/member`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    },
    discordGuildMemberSchema,
    (parsedMember) => parsedMember,
  );
}

export async function revokeAccessToken(
  env: DiscordEnv,
  accessToken: string,
): Promise<Result<void, DiscordApiError>> {
  const revokeEndpoint = `${DISCORD_API_BASE_URL}/oauth2/token/revoke`;
  const responseResult = await fetchDiscord(revokeEndpoint, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: createDiscordBasicAuthHeader(env),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      token: accessToken,
      token_type_hint: "access_token",
    }),
  });
  if (responseResult.isErr()) {
    return err(responseResult.error);
  }

  const response = responseResult.value;

  if (response.ok) {
    return ok(undefined);
  }

  const responseText = await response.text();
  let responseJson: unknown = undefined;
  if (responseText.trim().length > 0) {
    try {
      responseJson = JSON.parse(responseText);
    } catch {
      responseJson = undefined;
    }
  }
  return err(
    DiscordApiError.fromHttpFailure(
      response.status,
      response.statusText,
      revokeEndpoint,
      trimResponseBody(responseText),
      responseJson,
    ),
  );
}

export function getDiscordErrorMessage(error: DiscordApiError): string {
  if (error.responseBodyJson && typeof error.responseBodyJson === "object") {
    for (const key of ["error_description", "error", "message"]) {
      const descriptor = Object.getOwnPropertyDescriptor(
        error.responseBodyJson,
        key,
      );
      if (
        typeof descriptor?.value === "string" &&
        descriptor.value.trim().length > 0
      ) {
        return descriptor.value;
      }
    }
  }

  if (error.responseBodyText && !looksLikeHtml(error.responseBodyText)) {
    return error.responseBodyText;
  }

  if (error.statusText && error.statusText.trim().length > 0) {
    return error.statusText;
  }

  const mappedHttpMessage = discordHttpKindMessage[error.kind];
  if (mappedHttpMessage) {
    return mappedHttpMessage;
  }

  return error.message;
}
