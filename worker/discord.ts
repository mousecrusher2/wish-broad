import { Bindings } from "./types";
import * as v from "valibot";

type DiscordEnv = Pick<Bindings, "DISCORD_CLIENT_ID" | "DISCORD_CLIENT_SECRET">;

const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

type DiscordUser = {
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

// The guild member response already includes the user object, so `identify`
// (which only unlocks /users/@me) is unnecessary.
const DISCORD_OAUTH_SCOPE = "guilds.members.read";

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

function trimResponseBody(text: string): string | undefined {
  const normalized = text.replaceAll(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.slice(0, 200);
}

function looksLikeHtml(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith("<");
}

function createDiscordBasicAuthHeader(env: DiscordEnv): string {
  const credentials = `${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`;
  return `Basic ${btoa(credentials)}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * @throws {DiscordApiError} When the request fails or times out before Discord
 * answers.
 */
async function fetchDiscordWithTimeout(
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, DISCORD_FETCH_TIMEOUT_MS);

  try {
    return await fetch(endpoint, {
      ...init,
      signal: abortController.signal,
    });
  } catch (error: unknown) {
    const timedOut = isAbortError(error);
    const failureMessage =
      error instanceof Error ? error.message : String(error);
    throw new DiscordApiError(
      timedOut ? "Discord request timed out" : failureMessage,
      {
        endpoint,
        kind: timedOut ? "request_timeout" : "request_failed",
      },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @throws {DiscordApiError} When the request fails, Discord answers with an
 * HTTP error, or the body is not JSON matching `schema`.
 */
async function fetchDiscordJson<TInput, TOutput>(
  endpoint: string,
  init: RequestInit,
  schema: v.GenericSchema<unknown, TInput>,
  mapParsed: (parsed: TInput) => TOutput,
): Promise<TOutput> {
  const response = await fetchDiscordWithTimeout(endpoint, init);
  const responseText = await response.text();
  let responseJson: unknown = undefined;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    responseJson = undefined;
  }

  if (!response.ok) {
    throw DiscordApiError.fromHttpFailure(
      response.status,
      response.statusText,
      endpoint,
      trimResponseBody(responseText),
      responseJson,
    );
  }

  if (responseJson === undefined) {
    throw new DiscordApiError("Discord returned a non-JSON response", {
      endpoint,
      kind: "non_json_response",
      statusText: response.statusText,
      responseBodyText: trimResponseBody(responseText),
      responseBodyJson: responseJson,
    });
  }

  const parsedBody = v.safeParse(schema, responseJson);
  if (!parsedBody.success) {
    throw new DiscordApiError("Discord returned an unexpected JSON response", {
      endpoint,
      kind: "unexpected_json_response",
      statusText: response.statusText,
      responseBodyText: trimResponseBody(responseText),
      responseBodyJson: responseJson,
    });
  }

  return mapParsed(parsedBody.output);
}

function createDiscordOAuthTokenResponseSchema() {
  return v.object({
    access_token: v.string(),
    token_type: v.string(),
    expires_in: v.number(),
    refresh_token: v.optional(v.string()),
    scope: v.string(),
  });
}

let discordOAuthTokenResponseSchema:
  ReturnType<typeof createDiscordOAuthTokenResponseSchema> | undefined;

function getDiscordOAuthTokenResponseSchema() {
  discordOAuthTokenResponseSchema ??= createDiscordOAuthTokenResponseSchema();

  return discordOAuthTokenResponseSchema;
}

function createDiscordUserSchema() {
  return v.object({
    id: v.string(),
    username: v.string(),
    discriminator: v.optional(v.nullish(v.string())),
    global_name: v.optional(v.nullish(v.string())),
  });
}

let discordUserSchema: ReturnType<typeof createDiscordUserSchema> | undefined;

function getDiscordUserSchema() {
  discordUserSchema ??= createDiscordUserSchema();

  return discordUserSchema;
}

function createDiscordGuildMemberSchema() {
  return v.object({
    user: getDiscordUserSchema(),
    nick: v.optional(v.nullish(v.string())),
  });
}

let discordGuildMemberSchema:
  ReturnType<typeof createDiscordGuildMemberSchema> | undefined;

function getDiscordGuildMemberSchema() {
  discordGuildMemberSchema ??= createDiscordGuildMemberSchema();

  return discordGuildMemberSchema;
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
  url.searchParams.set("scope", DISCORD_OAUTH_SCOPE);
  url.searchParams.set("state", state);
  return url.toString();
}

/**
 * Exchange an OAuth authorization code for a Discord access token.
 *
 * @throws {DiscordApiError} When the request fails or Discord rejects the code.
 */
export async function exchangeCodeForToken(
  env: DiscordEnv,
  code: string,
  redirectUri: string,
): Promise<DiscordOAuthToken> {
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
    getDiscordOAuthTokenResponseSchema(),
    (parsedToken) => ({
      accessToken: parsedToken.access_token,
      expiresIn: parsedToken.expires_in,
      refreshToken: parsedToken.refresh_token,
      scope: parsedToken.scope,
      tokenType: parsedToken.token_type,
    }),
  );
}

/**
 * Look up the token owner's membership in one guild.
 *
 * @throws {DiscordApiError} When the request fails or Discord rejects it,
 * including `unauthorized`, `forbidden`, or `not_found` for a user who is not a
 * member.
 */
export async function getGuildMember(
  accessToken: string,
  guildId: string,
): Promise<DiscordGuildMember> {
  return fetchDiscordJson(
    `${DISCORD_API_BASE_URL}/users/@me/guilds/${encodeURIComponent(guildId)}/member`,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    },
    getDiscordGuildMemberSchema(),
    (parsedMember) => parsedMember,
  );
}

/**
 * Revoke a Discord access token.
 *
 * @throws {DiscordApiError} When the request fails or Discord rejects it.
 */
export async function revokeAccessToken(
  env: DiscordEnv,
  accessToken: string,
): Promise<void> {
  const revokeEndpoint = `${DISCORD_API_BASE_URL}/oauth2/token/revoke`;
  const response = await fetchDiscordWithTimeout(revokeEndpoint, {
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
  if (response.ok) {
    return;
  }

  const responseText = await response.text();
  let responseJson: unknown = undefined;
  try {
    responseJson = JSON.parse(responseText);
  } catch {
    responseJson = undefined;
  }
  throw DiscordApiError.fromHttpFailure(
    response.status,
    response.statusText,
    revokeEndpoint,
    trimResponseBody(responseText),
    responseJson,
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
