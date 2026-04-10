import { Bindings, DiscordGuildMember, DiscordOAuthToken } from "./types";
import {
  parseDiscordGuildMember,
  parseDiscordOAuthToken,
  SchemaValidationError,
} from "./validation";

type DiscordEnv = Pick<Bindings, "DISCORD_CLIENT_ID" | "DISCORD_CLIENT_SECRET">;

const DISCORD_AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

export const DISCORD_OAUTH_SCOPES = [
  "identify",
  "guilds.members.read",
] as const;

export const DISCORD_STATE_COOKIE_NAME = "discord_oauth_state";
export const DISCORD_STATE_MAX_AGE_SECONDS = 60 * 10;

export class DiscordApiError extends Error {
  constructor(
    message: string,
    public readonly endpoint: string,
    public readonly statusCode?: number,
    public readonly statusText?: string,
    public readonly responseBodyText?: string,
    public readonly responseBodyJson?: unknown,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
}

type ParsedDiscordBody = {
  json?: unknown;
  text: string;
};

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
  return `Basic ${btoa(`${env.DISCORD_CLIENT_ID}:${env.DISCORD_CLIENT_SECRET}`)}`;
}

function createDiscordApiError(
  message: string,
  endpoint: string,
  response?: Response,
  body?: ParsedDiscordBody,
): DiscordApiError {
  return new DiscordApiError(
    message,
    endpoint,
    response?.status,
    response?.statusText,
    trimResponseBody(body?.text),
    body?.json,
  );
}

async function parseDiscordResponseBody(
  response: Response,
): Promise<ParsedDiscordBody> {
  const text = await response.text();

  if (text.trim().length === 0) {
    return { json: undefined, text };
  }

  try {
    return {
      json: JSON.parse(text) as unknown,
      text,
    };
  } catch {
    return {
      json: undefined,
      text,
    };
  }
}

async function fetchDiscordJson<T>(
  endpoint: string,
  init: RequestInit,
  parse: (input: unknown, source: string) => T,
  source: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(endpoint, init);
  } catch (error) {
    throw new DiscordApiError(
      error instanceof Error ? error.message : "Discord request failed",
      endpoint,
    );
  }

  const body = await parseDiscordResponseBody(response);
  if (!response.ok) {
    throw createDiscordApiError(
      `Discord request failed with status ${String(response.status)}`,
      endpoint,
      response,
      body,
    );
  }

  if (body.json === undefined) {
    throw createDiscordApiError(
      "Discord returned a non-JSON response",
      endpoint,
      response,
      body,
    );
  }

  try {
    return parse(body.json, source);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw createDiscordApiError(
        "Discord returned an unexpected JSON response",
        endpoint,
        response,
        body,
      );
    }

    throw error;
  }
}

async function fetchDiscord(
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(endpoint, init);
  } catch (error) {
    throw new DiscordApiError(
      error instanceof Error ? error.message : "Discord request failed",
      endpoint,
    );
  }
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
    parseDiscordOAuthToken,
    "Discord OAuth token response",
  );
}

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
    parseDiscordGuildMember,
    "Discord guild member response",
  );
}

export async function revokeAccessToken(
  env: DiscordEnv,
  accessToken: string,
): Promise<void> {
  const revokeEndpoint = `${DISCORD_API_BASE_URL}/oauth2/token/revoke`;
  const response = await fetchDiscord(revokeEndpoint, {
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

  const body = await parseDiscordResponseBody(response);
  throw createDiscordApiError(
    `Discord token revocation failed with status ${String(response.status)}`,
    revokeEndpoint,
    response,
    body,
  );
}

export function getDiscordErrorMessage(error: DiscordApiError): string {
  if (error.responseBodyJson && typeof error.responseBodyJson === "object") {
    const body = error.responseBodyJson as Record<string, unknown>;
    for (const key of ["error_description", "error", "message"]) {
      if (typeof body[key] === "string" && body[key].trim().length > 0) {
        return body[key];
      }
    }
  }

  if (error.responseBodyText && !looksLikeHtml(error.responseBodyText)) {
    return error.responseBodyText;
  }

  if (error.statusCode) {
    return `${String(error.statusCode)} ${error.statusText ?? ""}`.trim();
  }

  return error.message;
}
