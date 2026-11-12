import * as v from "valibot";
import type { Bindings } from "./types";

type TurnEnv = Pick<Bindings, "TURN_KEY_API_TOKEN" | "TURN_KEY_ID">;

type RawIceServer = {
  urls: string | string[];
  username?: string | undefined;
  credential?: string | undefined;
};

type TurnCredentialsResponse = {
  iceServers: RawIceServer[];
};

export type TurnIceServer = {
  urls: string[];
  username?: string;
  credential?: string;
};

type TurnApiErrorKind =
  | "request_failed"
  | "request_timeout"
  | "http_error"
  | "invalid_response_json"
  | "invalid_response_schema"
  | "empty_ice_servers";

export class TurnApiError extends Error {
  readonly endpoint: string;
  readonly kind: TurnApiErrorKind;
  readonly responseBody: unknown;
  readonly statusText: string | undefined;

  constructor(
    message: string,
    options: {
      endpoint: string;
      kind: TurnApiErrorKind;
      responseBody?: unknown;
      statusText?: string | undefined;
    },
  ) {
    super(message);
    this.name = "TurnApiError";
    this.endpoint = options.endpoint;
    this.kind = options.kind;
    this.responseBody = options.responseBody;
    this.statusText = options.statusText;
  }
}

const TURN_CREDENTIAL_TTL_SECONDS = 86_400;
const TURN_FETCH_TIMEOUT_MS = 5_000;

function createRawIceServerSchema() {
  return v.object({
    urls: v.union([v.string(), v.array(v.string())]),
    username: v.optional(v.string()),
    credential: v.optional(v.string()),
  });
}

let rawIceServerSchema: ReturnType<typeof createRawIceServerSchema> | undefined;

function getRawIceServerSchema() {
  rawIceServerSchema ??= createRawIceServerSchema();

  return rawIceServerSchema;
}

function createTurnCredentialsResponseSchema() {
  return v.object({
    iceServers: v.array(getRawIceServerSchema()),
  });
}

let turnCredentialsResponseSchema:
  ReturnType<typeof createTurnCredentialsResponseSchema> | undefined;

function getTurnCredentialsResponseSchema() {
  turnCredentialsResponseSchema ??= createTurnCredentialsResponseSchema();

  return turnCredentialsResponseSchema;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toUrlList(urls: string | string[]): string[] {
  return Array.isArray(urls) ? urls : [urls];
}

function getIceServerPort(url: string): number | null {
  const schemeSeparatorIndex = url.indexOf(":");
  if (schemeSeparatorIndex < 0) {
    return null;
  }

  const querySeparatorIndex = url.indexOf("?");
  const authority =
    querySeparatorIndex >= 0
      ? url.slice(schemeSeparatorIndex + 1, querySeparatorIndex)
      : url.slice(schemeSeparatorIndex + 1);
  if (authority.length === 0) {
    return null;
  }

  if (authority.startsWith("[")) {
    const bracketIndex = authority.indexOf("]");
    if (bracketIndex < 0) {
      return null;
    }

    const portText = authority.slice(bracketIndex + 2);
    if (portText.length === 0) {
      return null;
    }

    const port = Number.parseInt(portText, 10);
    return Number.isInteger(port) ? port : null;
  }

  const lastColonIndex = authority.lastIndexOf(":");
  if (lastColonIndex < 0) {
    return null;
  }

  const portText = authority.slice(lastColonIndex + 1);
  if (portText.length === 0) {
    return null;
  }

  const port = Number.parseInt(portText, 10);
  return Number.isInteger(port) ? port : null;
}

function filterIceServerUrls(iceServer: RawIceServer): TurnIceServer | null {
  // Cloudflare returns primary and alternate TURN ports, but browsers are known
  // to block port 53. Because this client waits for full ICE gathering instead
  // of using trickle ICE, keep blocked candidates out to avoid setup timeouts.
  const urls = toUrlList(iceServer.urls).filter((url) => {
    return getIceServerPort(url) !== 53;
  });
  if (urls.length === 0) {
    return null;
  }

  return {
    ...(iceServer.credential ? { credential: iceServer.credential } : {}),
    ...(iceServer.username ? { username: iceServer.username } : {}),
    urls,
  };
}

/**
 * @throws {TurnApiError} When the request fails or times out before Cloudflare
 * answers.
 */
async function fetchTurnCredentials(
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, TURN_FETCH_TIMEOUT_MS);

  try {
    return await fetch(endpoint, {
      ...init,
      signal: abortController.signal,
    });
  } catch (error: unknown) {
    const timedOut = isAbortError(error);
    throw new TurnApiError(
      timedOut
        ? "TURN credential request timed out"
        : "TURN credential request failed",
      {
        endpoint,
        kind: timedOut ? "request_timeout" : "request_failed",
        responseBody: error instanceof Error ? error.message : String(error),
      },
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @throws {TurnApiError} When Cloudflare answers with an HTTP error or a body
 * that is not the expected JSON.
 */
async function parseTurnCredentialsResponse(
  endpoint: string,
  response: Response,
): Promise<TurnCredentialsResponse> {
  if (!response.ok) {
    const responseBody: unknown = await response
      .json()
      .catch(() => response.text().catch(() => null));
    throw new TurnApiError("TURN credential request failed", {
      endpoint,
      kind: "http_error",
      responseBody,
      statusText: response.statusText,
    });
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch (error: unknown) {
    throw new TurnApiError("TURN credential response was not valid JSON", {
      endpoint,
      kind: "invalid_response_json",
      responseBody: error instanceof Error ? error.message : String(error),
      statusText: response.statusText,
    });
  }

  const parsedResponse = v.safeParse(
    getTurnCredentialsResponseSchema(),
    responseBody,
  );
  if (!parsedResponse.success) {
    throw new TurnApiError("TURN credential response schema was invalid", {
      endpoint,
      kind: "invalid_response_schema",
      responseBody: {
        issues: parsedResponse.issues,
        responseBody,
      },
      statusText: response.statusText,
    });
  }

  return parsedResponse.output;
}

/**
 * Generate short-lived TURN credentials for one viewer.
 *
 * @throws {TurnApiError} When the credentials cannot be generated or contain
 * no ICE server that browsers can use.
 */
export async function generateTurnIceServers(
  env: TurnEnv,
  customIdentifier: string,
): Promise<TurnIceServer[]> {
  const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`;
  const response = await fetchTurnCredentials(endpoint, {
    body: JSON.stringify({
      customIdentifier,
      ttl: TURN_CREDENTIAL_TTL_SECONDS,
    }),
    headers: {
      Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const credentials = await parseTurnCredentialsResponse(endpoint, response);

  const iceServers = credentials.iceServers
    .map(filterIceServerUrls)
    .filter((iceServer) => iceServer !== null);
  if (iceServers.length === 0) {
    throw new TurnApiError(
      "TURN credential response did not contain usable ICE servers",
      {
        endpoint,
        kind: "empty_ice_servers",
        responseBody: credentials,
      },
    );
  }

  return iceServers;
}
