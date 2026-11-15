import { Bindings } from "../types";
import * as v from "valibot";
import { createRandomHex } from "../lib/hex";
import { fetchWithTimeout, trimResponseBody } from "./http";

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

const DISCORD_OAUTH_SCOPE = "guilds.members.read";

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

function looksLikeHtml(text: string): boolean {
  const normalized = text.trim();
  return normalized.startsWith("<");
}

function createDiscordBasicAuthHeader(env: DiscordEnv): string {
  const credentials = `${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`;
  return `Basic ${btoa(credentials)}`;
}

/**
 * @throws {DiscordApiError} Discord の応答前にリクエストが失敗またはタイムアウトした場合。
 */
async function fetchDiscordWithTimeout(
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  return fetchWithTimeout(
    endpoint,
    init,
    DISCORD_FETCH_TIMEOUT_MS,
    (kind, error) => {
      if (kind === "request_timeout") {
        return new DiscordApiError("Discord request timed out", {
          endpoint,
          kind,
        });
      }
      return new DiscordApiError(
        error instanceof Error ? error.message : String(error),
        { endpoint, kind },
      );
    },
  );
}

/**
 * @throws {DiscordApiError} リクエストに失敗したか、Discord が HTTP エラーを返したか、
 * レスポンスボディが `schema` に一致する JSON でない場合。
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
  return createRandomHex(32);
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
 * OAuth 認可コードを Discord アクセストークンに交換する。
 *
 * @throws {DiscordApiError} リクエストに失敗したか、Discord がコードを拒否した場合。
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
 * 指定されたサーバー（ギルド）におけるトークン所有者のメンバー情報を照会する。
 *
 * @throws {DiscordApiError} リクエストに失敗したか Discord に拒否された場合。
 * 非メンバーユーザーに対する `unauthorized`、`forbidden`、`not_found` も含む。
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
 * Discord アクセストークンを失効（revoke）させる。
 *
 * @throws {DiscordApiError} リクエストに失敗したか Discord に拒否された場合。
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
