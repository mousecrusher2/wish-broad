import * as v from "valibot";
import {
  type FetchedResponse,
  fetchWithTimeout,
  parseResponseBody,
} from "./http";
import type { Bindings } from "../types";

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
/**
 * 視聴者は TURN を取得できなくても TURN なしで接続を続けるため、接続のたびに挟まる取得を
 * 長く待たずに早めに諦める。
 */
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

function toUrlList(urls: string | string[]): string[] {
  return Array.isArray(urls) ? urls : [urls];
}

/**
 * ポート 53 を指す STUN / TURN URI。URI の形式は `scheme:host[:port][?transport=udp|tcp]`
 * （RFC 7064、RFC 7065）であるため、ポートはクエリ文字列または末尾の直前に現れる。
 * 53 で終わる IPv6 ホストは直後に "]" が続くため一致しない。
 */
const PORT_53_PATTERN = /:0*53(?:\?|$)/u;

/**
 * ブラウザがブロックするポート 53 の URL を取り除く（理由は docs/architecture.md の
 * 「WHEPクライアントの設計判断」）。URL が残らなければ null を返す。
 */
function filterIceServerUrls(iceServer: RawIceServer): TurnIceServer | null {
  const urls = toUrlList(iceServer.urls).filter((url) => {
    return !PORT_53_PATTERN.test(url);
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
 * @throws {TurnApiError} Cloudflare の応答の本文を読み切る前にリクエストが失敗またはタイムアウトした場合。
 */
async function fetchTurnCredentials(
  endpoint: string,
  init: RequestInit,
): Promise<FetchedResponse> {
  return fetchWithTimeout(
    endpoint,
    init,
    TURN_FETCH_TIMEOUT_MS,
    (kind, error) =>
      new TurnApiError(
        kind === "request_timeout"
          ? "TURN credential request timed out"
          : "TURN credential request failed",
        {
          endpoint,
          kind,
          responseBody: error instanceof Error ? error.message : String(error),
        },
      ),
  );
}

/**
 * @throws {TurnApiError} Cloudflare が HTTP エラーを返したか、期待する JSON ではない
 * ボディを返した場合。
 */
function parseTurnCredentialsResponse(
  endpoint: string,
  response: FetchedResponse,
): TurnCredentialsResponse {
  if (!response.ok) {
    const responseBody = parseResponseBody(response.bodyText);
    throw new TurnApiError("TURN credential request failed", {
      endpoint,
      kind: "http_error",
      responseBody,
      statusText: response.statusText,
    });
  }

  let responseBody: unknown;
  try {
    responseBody = JSON.parse(response.bodyText);
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
 * 1 人の視聴者向けに短命な TURN クレデンシャルを生成する。
 *
 * @throws {TurnApiError} クレデンシャルを生成できないか、ブラウザが利用可能な
 * ICE サーバーが 1 つも含まれていなかった場合。
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
  const credentials = parseTurnCredentialsResponse(endpoint, response);

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
