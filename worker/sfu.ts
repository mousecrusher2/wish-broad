import { Bindings } from "./types";
import * as v from "valibot";
import { fetchWithTimeout, readResponseBody } from "./http";

type SessionDescription = {
  sdp: string;
  type: string;
};

type NewSessionResponse = {
  sessionId: string;
};

type NewTrackResponse = {
  trackName: string;
  mid?: string | undefined;
  sessionId?: string | undefined;
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
};

type NewTracksResponse = {
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
  requiresImmediateRenegotiation?: boolean | undefined;
  tracks?: NewTrackResponse[] | undefined;
  sessionDescription?: SessionDescription | undefined;
};

type TrackLocator = {
  location: string;
  sessionId: string;
  trackName: string;
};

export type StoredTrack = TrackLocator & {
  mid: string;
};

export type IngestSession = {
  sessionId: string;
  sdpAnswer: string;
  tracks: StoredTrack[];
};

export type PlaybackSession = {
  sessionId: string;
  sdpAnswer: string;
  sdpType: "answer" | "offer";
  tracks: StoredTrack[];
};

type ClosedTrack = {
  mid: string;
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
  sessionId?: string | undefined;
  trackName?: string | undefined;
};

type CloseTracksResponse = {
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
  requiresImmediateRenegotiation?: boolean | undefined;
  sessionDescription?: SessionDescription | undefined;
  tracks?: ClosedTrack[] | undefined;
};

type SfuNegotiationClientStatus = 400 | 415 | 422 | 504;

type SfuApiErrorKind =
  | "request_failed"
  | "request_timeout"
  | "bad_request"
  | "unsupported_media_type"
  | "unprocessable_content"
  | "session_not_found"
  | "session_gone"
  | "http_error"
  | "invalid_response_json"
  | "invalid_response_schema"
  | "track_negotiation_error"
  | "invalid_sfu_response";

export class SfuApiError extends Error {
  readonly endpoint: string;
  readonly kind: SfuApiErrorKind;
  readonly responseBody: unknown;
  readonly statusText: string | undefined;

  constructor(
    message: string,
    options: {
      endpoint: string;
      kind: SfuApiErrorKind;
      responseBody?: unknown;
      statusText?: string | undefined;
    },
  ) {
    super(message);
    this.name = "SfuApiError";
    this.endpoint = options.endpoint;
    this.kind = options.kind;
    this.responseBody = options.responseBody;
    this.statusText = options.statusText;
  }

  isSessionNotFound(): boolean {
    return this.kind === "session_not_found";
  }

  toNegotiationClientError(
    fallbackText: string,
  ): { status: SfuNegotiationClientStatus; text: string } | null {
    const text =
      typeof this.responseBody === "string" && this.responseBody.length > 0
        ? this.responseBody
        : fallbackText;
    if (this.kind === "bad_request") {
      return { status: 400, text };
    }
    if (this.kind === "unsupported_media_type") {
      return { status: 415, text };
    }
    if (this.kind === "unprocessable_content") {
      return { status: 422, text };
    }
    if (this.kind === "request_timeout") {
      return { status: 504, text };
    }

    return null;
  }
}

export class LiveNotFoundError extends Error {
  constructor(liveId: string) {
    super(`Live stream not found: ${liveId}`);
    this.name = "LiveNotFoundError";
  }
}

function classifyHttpFailure(status: number): {
  kind: SfuApiErrorKind;
  message: string;
} {
  switch (status) {
    case 400:
      return {
        kind: "bad_request",
        message: "SFU request failed: bad request",
      };
    case 404:
      return {
        kind: "session_not_found",
        message: "SFU request failed: session not found",
      };
    case 410:
      return {
        kind: "session_gone",
        message: "SFU request failed: session gone",
      };
    case 415:
      return {
        kind: "unsupported_media_type",
        message: "SFU request failed: unsupported media type",
      };
    case 422:
      return {
        kind: "unprocessable_content",
        message: "SFU request failed: unprocessable content",
      };
    default:
      return { kind: "http_error", message: "SFU request failed" };
  }
}

async function createHttpError(
  response: Response,
  endpoint: string,
): Promise<SfuApiError> {
  const responseBody = await readResponseBody(response);
  const { kind, message } = classifyHttpFailure(response.status);
  return new SfuApiError(message, {
    endpoint,
    kind,
    responseBody,
    statusText: response.statusText,
  });
}

function createSessionDescriptionSchema() {
  return v.object({
    sdp: v.string(),
    type: v.string(),
  });
}

let sessionDescriptionSchema:
  ReturnType<typeof createSessionDescriptionSchema> | undefined;

function getSessionDescriptionSchema() {
  sessionDescriptionSchema ??= createSessionDescriptionSchema();

  return sessionDescriptionSchema;
}

function createNewTrackResponseSchema() {
  return v.object({
    trackName: v.string(),
    mid: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    errorCode: v.optional(v.string()),
    errorDescription: v.optional(v.string()),
  });
}

let newTrackResponseSchema:
  ReturnType<typeof createNewTrackResponseSchema> | undefined;

function getNewTrackResponseSchema() {
  newTrackResponseSchema ??= createNewTrackResponseSchema();

  return newTrackResponseSchema;
}

function createNewSessionResponseSchema() {
  return v.object({
    sessionId: v.string(),
  });
}

let newSessionResponseSchema:
  ReturnType<typeof createNewSessionResponseSchema> | undefined;

function getNewSessionResponseSchema() {
  newSessionResponseSchema ??= createNewSessionResponseSchema();

  return newSessionResponseSchema;
}

function createNewTracksResponseSchema() {
  return v.object({
    errorCode: v.optional(v.string()),
    errorDescription: v.optional(v.string()),
    requiresImmediateRenegotiation: v.optional(v.boolean()),
    tracks: v.optional(v.array(getNewTrackResponseSchema())),
    sessionDescription: v.optional(getSessionDescriptionSchema()),
  });
}

let newTracksResponseSchema:
  ReturnType<typeof createNewTracksResponseSchema> | undefined;

function getNewTracksResponseSchema() {
  newTracksResponseSchema ??= createNewTracksResponseSchema();

  return newTracksResponseSchema;
}

function createCloseTrackResultSchema() {
  return v.object({
    mid: v.string(),
    errorCode: v.optional(v.string()),
    errorDescription: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    trackName: v.optional(v.string()),
  });
}

let closeTrackResultSchema:
  ReturnType<typeof createCloseTrackResultSchema> | undefined;

function getCloseTrackResultSchema() {
  closeTrackResultSchema ??= createCloseTrackResultSchema();

  return closeTrackResultSchema;
}

function createCloseTracksResponseSchema() {
  return v.object({
    errorCode: v.optional(v.string()),
    errorDescription: v.optional(v.string()),
    requiresImmediateRenegotiation: v.optional(v.boolean()),
    sessionDescription: v.optional(getSessionDescriptionSchema()),
    tracks: v.optional(v.array(getCloseTrackResultSchema())),
  });
}

let closeTracksResponseSchema:
  ReturnType<typeof createCloseTracksResponseSchema> | undefined;

function getCloseTracksResponseSchema() {
  closeTracksResponseSchema ??= createCloseTracksResponseSchema();

  return closeTracksResponseSchema;
}

type SfuEnv = Pick<Bindings, "CALLS_APP_ID" | "CALLS_APP_SECRET">;
type TrackLocatorRequest = Pick<
  TrackLocator,
  "location" | "sessionId" | "trackName"
>;

const WHIP_MAX_TRACK_COUNT = 2;
const SFU_FETCH_TIMEOUT_MS = 8_000;

function getHeaders(env: SfuEnv): Record<string, string> {
  return {
    Authorization: `Bearer ${env.CALLS_APP_SECRET}`,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * @throws {SfuApiError} SFU の応答前にリクエストが失敗またはタイムアウトした場合。
 */
async function fetchSfu(
  endpoint: string,
  init: RequestInit,
): Promise<Response> {
  return fetchWithTimeout(
    endpoint,
    init,
    SFU_FETCH_TIMEOUT_MS,
    (kind, error) =>
      new SfuApiError(
        kind === "request_timeout"
          ? "SFU request timed out"
          : "SFU request failed",
        { endpoint, kind, responseBody: getErrorMessage(error) },
      ),
  );
}

function normalizeTrackLocator(track: TrackLocator): TrackLocatorRequest {
  return {
    location: track.location,
    sessionId: track.sessionId,
    trackName: track.trackName,
  };
}

/**
 * SFU API リクエストを 1 回送信し、JSON レスポンスボディを検証する。
 *
 * @throws {SfuApiError} リクエストに失敗したか、SFU が HTTP エラーを返したか、
 * レスポンスボディが `schema` に一致する JSON でない場合。
 */
async function requestSfuJson<TOutput>(
  endpoint: string,
  init: RequestInit,
  schema: v.GenericSchema<unknown, TOutput>,
): Promise<TOutput> {
  const response = await fetchSfu(endpoint, init);
  if (!response.ok) {
    throw await createHttpError(response, endpoint);
  }

  let responseBody: unknown;
  try {
    responseBody = await response.json();
  } catch (error: unknown) {
    throw new SfuApiError("Invalid SFU response JSON", {
      endpoint,
      kind: "invalid_response_json",
      responseBody: {
        error: getErrorMessage(error),
      },
    });
  }

  const parsedResponse = v.safeParse(schema, responseBody);
  if (!parsedResponse.success) {
    throw new SfuApiError("Invalid SFU response schema", {
      endpoint,
      kind: "invalid_response_schema",
      responseBody: {
        issues: parsedResponse.issues,
        responseBody,
      },
    });
  }

  return parsedResponse.output;
}

/**
 * SFU セッションを作成する。
 *
 * インジェストセッションは後で LiveState に保存される。再生セッションは
 * 視聴者の接続試行ごとに作成され、返される WHEP セッション URL の中でのみ保持される。
 *
 * @throws {SfuApiError} SFU がセッションを作成できなかった場合。
 */
async function createSession(env: SfuEnv): Promise<NewSessionResponse> {
  const endpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/new`;
  return requestSfuJson(
    endpoint,
    {
      method: "POST",
      headers: getHeaders(env),
    },
    getNewSessionResponseSchema(),
  );
}

/**
 * WHIP オファーからインジェストトラックを作成する。
 *
 * `autoDiscover` を使うことで、Worker 側で個別のトラック名を事前宣言しなくても
 * OBS が音声/映像トラックをオファーできるようになる。
 *
 * @throws {SfuApiError} SFU がトラックを作成できなかった場合。
 */
async function createIngestTracks(
  env: SfuEnv,
  sessionId: string,
  sdpOffer: string,
): Promise<NewTracksResponse> {
  const body = {
    sessionDescription: {
      type: "offer",
      sdp: sdpOffer,
    },
    autoDiscover: true,
  };

  const endpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionId}/tracks/new`;
  return requestSfuJson(
    endpoint,
    {
      method: "POST",
      headers: {
        ...getHeaders(env),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    getNewTracksResponseSchema(),
  );
}

/**
 * 保存されたインジェストトラックロケーターに再生セッションをアタッチする。
 *
 * SDP オファーを渡すと SFU が直接アンサーを返す場合があるほか、SFU が
 * カウンターオファーを返す場合もあり、その際は WHEP ルートが `renegotiateSession`
 * を通じてアンサーを送信する。
 *
 * @throws {SfuApiError} トラックネゴシエーションエラーの報告を含め、SFU が
 * トラックをアタッチできなかった場合。
 */
async function connectToTracks(
  env: SfuEnv,
  sessionId: string,
  tracks: TrackLocator[],
  sdpOffer?: string,
): Promise<NewTracksResponse> {
  const normalizedTracks = tracks.map((track) => normalizeTrackLocator(track));
  const body =
    sdpOffer && sdpOffer.trim().length > 0
      ? {
          sessionDescription: {
            type: "offer",
            sdp: sdpOffer,
          },
          tracks: normalizedTracks,
        }
      : {
          tracks: normalizedTracks,
        };

  const endpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionId}/tracks/new`;
  const response = await requestSfuJson(
    endpoint,
    {
      method: "POST",
      headers: {
        ...getHeaders(env),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    getNewTracksResponseSchema(),
  );
  const hasTrackNegotiationErrors =
    !!response.errorCode ||
    !!response.errorDescription ||
    !!response.tracks?.some((track) => !!track.errorCode);
  if (hasTrackNegotiationErrors) {
    throw new SfuApiError("SFU returned track negotiation errors", {
      endpoint,
      kind: "track_negotiation_error",
      responseBody: response,
    });
  }
  return response;
}

/**
 * SFU のカウンターオファーに対するアンサーを送信する。
 *
 * トリクル ICE 候補の PATCH には使用しない（フロントエンドは POST/PATCH 前に
 * 完全な SDP を収集する）。
 *
 * @throws {SfuApiError} リクエストに失敗したか、SFU がアンサーを拒否した場合。
 */
export async function renegotiateSession(
  env: SfuEnv,
  sessionId: string,
  sdpAnswer: string,
): Promise<void> {
  const body = {
    sessionDescription: {
      type: "answer",
      sdp: sdpAnswer,
    },
  };

  const endpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionId}/renegotiate`;
  const response = await fetchSfu(endpoint, {
    method: "PUT",
    headers: {
      ...getHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw await createHttpError(response, endpoint);
  }
}

/**
 * 1 つの SFU セッションに属するトラックを mid 指定でクローズする。
 *
 * トラックの mid は OBS の再接続や視聴者セッションをまたいで不変ではないため、
 * 呼び出し側はクローズ対象セッションそのものの mid を渡す必要がある。
 *
 * 成功レスポンス内でも SFU がトラックごとのエラーを返す場合があり、それを問題視するかは
 * 呼び出し側が判断する。
 *
 * @throws {SfuApiError} リクエストに失敗したか SFU に拒否された場合（すでに終了した
 * セッションに対する `session_not_found` や `session_gone` を含む）。
 */
export async function closeTracks(
  env: SfuEnv,
  sessionId: string,
  tracks: StoredTrack[],
): Promise<CloseTracksResponse> {
  const body = {
    force: true,
    tracks: tracks.map((track) => ({
      mid: track.mid,
    })),
  };

  const endpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionId}/tracks/close`;
  return requestSfuJson(
    endpoint,
    {
      method: "PUT",
      headers: {
        ...getHeaders(env),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
    getCloseTracksResponseSchema(),
  );
}

/**
 * 配信行の個別整合のため、1 つの SFU セッションをプローブする。
 *
 * 404/410 のみを「非アクティブ」とみなし、一時的な SFU 障害を配信行が古いことの
 * 証拠としては扱わない。
 *
 * @returns SFU がそのセッションを not found または gone と報告した場合にのみ `false`。
 * @throws {SfuApiError} リクエストに失敗したか、SFU がそれ以外の HTTP エラーを返した場合。
 */
export async function isSessionActive(
  env: SfuEnv,
  sessionId: string,
): Promise<boolean> {
  const endpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionId}`;
  const response = await fetchSfu(endpoint, {
    method: "GET",
    headers: getHeaders(env),
  });
  if (response.ok) {
    return true;
  }

  const error = await createHttpError(response, endpoint);
  if (error.kind === "session_not_found" || error.kind === "session_gone") {
    return false;
  }
  throw error;
}

/**
 * インジェストセッションを 1 つ開始し、SDP アンサーおよび永続化用トラックロケーターを返す。
 *
 * @throws {SfuApiError} SFU がセッションのネゴシエーションに失敗したか、
 * 使用できないインジェストレスポンスを返した場合。
 */
export async function startIngest(
  env: SfuEnv,
  _liveId: string,
  sdpOffer: string,
): Promise<IngestSession> {
  const { sessionId } = await createSession(env);
  const tracksResponse = await createIngestTracks(env, sessionId, sdpOffer);
  const ingestEndpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionId}/tracks/new`;
  const responseTracks = tracksResponse.tracks;
  const sdpAnswer = tracksResponse.sessionDescription?.sdp;

  if (!responseTracks || responseTracks.length === 0 || !sdpAnswer) {
    throw new SfuApiError("SFU response did not include ingest tracks or SDP", {
      endpoint: ingestEndpoint,
      kind: "invalid_sfu_response",
      responseBody: tracksResponse,
    });
  }
  if (responseTracks.length > WHIP_MAX_TRACK_COUNT) {
    // サポートしている OBS インジェスト構成は音声 1 トラック + 映像 1 トラックである。
    throw new SfuApiError("WHIP does not allow more than two ingest tracks", {
      endpoint: ingestEndpoint,
      kind: "invalid_sfu_response",
      responseBody: tracksResponse,
    });
  }

  const tracks = responseTracks.flatMap((track) =>
    typeof track.mid === "string"
      ? [
          {
            location: "remote",
            sessionId,
            trackName: track.trackName,
            mid: track.mid,
          },
        ]
      : [],
  );
  if (tracks.length !== responseTracks.length) {
    throw new SfuApiError("SFU response did not include track MID", {
      endpoint: ingestEndpoint,
      kind: "invalid_sfu_response",
      responseBody: tracksResponse,
    });
  }

  return {
    sessionId,
    sdpAnswer,
    tracks,
  };
}

/**
 * 保存済みのインジェストトラックに対して視聴者用再生セッションを 1 つ開始する。
 *
 * @throws {LiveNotFoundError} 配信に保存されたトラックが存在しない場合。
 * @throws {SfuApiError} SFU がセッションのネゴシエーションに失敗したか、
 * 使用できない再生レスポンスを返した場合。
 */
export async function startPlay(
  env: SfuEnv,
  liveId: string,
  tracks: TrackLocator[],
  sdpOffer?: string,
): Promise<PlaybackSession> {
  if (tracks.length === 0) {
    throw new LiveNotFoundError(liveId);
  }

  const { sessionId } = await createSession(env);
  const tracksResponse = await connectToTracks(
    env,
    sessionId,
    tracks,
    sdpOffer,
  );
  const sdpAnswer = tracksResponse.sessionDescription?.sdp;
  const sdpType = tracksResponse.sessionDescription?.type;
  const responseTracks = tracksResponse.tracks;
  const playbackEndpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionId}/tracks/new`;
  if (!sdpAnswer) {
    throw new SfuApiError("SFU response did not include SDP for playback", {
      endpoint: playbackEndpoint,
      kind: "invalid_sfu_response",
      responseBody: tracksResponse,
    });
  }
  if (!responseTracks || responseTracks.length === 0) {
    throw new SfuApiError("SFU response did not include playback tracks", {
      endpoint: playbackEndpoint,
      kind: "invalid_sfu_response",
      responseBody: tracksResponse,
    });
  }
  if (sdpType !== "answer" && sdpType !== "offer") {
    throw new SfuApiError(
      "SFU response did not include valid SDP type for playback",
      {
        endpoint: playbackEndpoint,
        kind: "invalid_sfu_response",
        responseBody: tracksResponse,
      },
    );
  }

  const playbackTracks = responseTracks.flatMap((track) =>
    typeof track.mid === "string"
      ? [
          {
            location: "remote",
            mid: track.mid,
            sessionId,
            trackName: track.trackName,
          },
        ]
      : [],
  );
  if (playbackTracks.length !== responseTracks.length) {
    throw new SfuApiError("SFU response did not include playback track MID", {
      endpoint: playbackEndpoint,
      kind: "invalid_sfu_response",
      responseBody: tracksResponse,
    });
  }

  return {
    sessionId,
    sdpAnswer,
    sdpType,
    tracks: playbackTracks,
  };
}
