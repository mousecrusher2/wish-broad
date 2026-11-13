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
 * @throws {SfuApiError} When the request fails or times out before Calls
 * answers.
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
 * Send one Calls API request and validate its JSON response body.
 *
 * @throws {SfuApiError} When the request fails, Calls answers with an HTTP
 * error, or the body is not JSON matching `schema`.
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
 * Create a Cloudflare Calls session.
 *
 * Ingest sessions are later persisted in D1. Playback sessions are per viewer
 * attempt and live only in the returned WHEP session URL.
 *
 * @throws {SfuApiError} When Calls cannot create the session.
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
 * Create ingest tracks from a WHIP offer.
 *
 * `autoDiscover` lets OBS offer its audio/video tracks without the Worker
 * predeclaring individual track names.
 *
 * @throws {SfuApiError} When Calls cannot create the tracks.
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
 * Attach a playback session to stored ingest track locators.
 *
 * Passing an SDP offer lets Calls answer directly. Calls may also return a
 * counter-offer, which the WHEP route answers through `renegotiateSession`.
 *
 * @throws {SfuApiError} When Calls cannot attach the tracks, including when it
 * reports track negotiation errors.
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
 * Submit the answer to a Calls counter-offer.
 *
 * This is not used for trickle ICE candidate PATCHes; the frontend gathers
 * complete SDP before POST/PATCH.
 *
 * @throws {SfuApiError} When the request fails or Calls rejects the answer.
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
 * Close tracks by mids that belong to one Calls session.
 *
 * Track mids are not stable across OBS reconnects or viewer sessions, so callers
 * must pass the mids from the exact session they are closing.
 *
 * Calls can still report per-track errors in a successful response; the caller
 * decides whether those matter.
 *
 * @throws {SfuApiError} When the request fails or Calls rejects it, including
 * `session_not_found` and `session_gone` for a session that already ended.
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
 * Probe one Calls session for targeted D1 reconciliation.
 *
 * Only 404/410 mean "inactive"; transient SFU failures should not be treated as
 * proof that a live row is stale.
 *
 * @returns `false` only when Calls reports the session as not found or gone.
 * @throws {SfuApiError} When the request fails or Calls answers with any other
 * HTTP error.
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
 * Start one ingest session and return the SDP answer plus durable track locators.
 *
 * @throws {SfuApiError} When Calls fails to negotiate the session or returns an
 * unusable ingest response.
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
    // The supported OBS ingest shape is one audio track plus one video track.
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
 * Start one viewer playback session for the stored ingest tracks.
 *
 * @throws {LiveNotFoundError} When the live has no stored tracks.
 * @throws {SfuApiError} When Calls fails to negotiate the session or returns an
 * unusable playback response.
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
