import { Bindings } from "./types";
import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";

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

export type TrackLocator = {
  location: string;
  sessionId: string;
  trackName: string;
};

export type StoredTrack = TrackLocator & {
  mid: string;
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

type SfuFailure = {
  message: string;
  endpoint: string;
  kind: SfuApiErrorKind;
  responseBody: unknown;
  statusText?: string | undefined;
};

function sfuFailureFromHttpFailure(
  status: number,
  statusText: string,
  endpoint: string,
  responseBody?: unknown,
): SfuFailure {
  if (status === 400) {
    return {
      message: "SFU request failed: bad request",
      endpoint,
      kind: "bad_request",
      responseBody,
      statusText,
    };
  }
  if (status === 404) {
    return {
      message: "SFU request failed: session not found",
      endpoint,
      kind: "session_not_found",
      responseBody,
      statusText,
    };
  }
  if (status === 410) {
    return {
      message: "SFU request failed: session gone",
      endpoint,
      kind: "session_gone",
      responseBody,
      statusText,
    };
  }
  if (status === 415) {
    return {
      message: "SFU request failed: unsupported media type",
      endpoint,
      kind: "unsupported_media_type",
      responseBody,
      statusText,
    };
  }
  if (status === 422) {
    return {
      message: "SFU request failed: unprocessable content",
      endpoint,
      kind: "unprocessable_content",
      responseBody,
      statusText,
    };
  }

  return {
    message: "SFU request failed",
    endpoint,
    kind: "http_error",
    responseBody,
    statusText,
  };
}

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

function createSessionDescriptionSchema() {
  return v.object({
    sdp: v.string(),
    type: v.string(),
  });
}

let sessionDescriptionSchema:
  | ReturnType<typeof createSessionDescriptionSchema>
  | undefined;

function getSessionDescriptionSchema() {
  if (sessionDescriptionSchema === undefined) {
    sessionDescriptionSchema = createSessionDescriptionSchema();
  }

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
  | ReturnType<typeof createNewTrackResponseSchema>
  | undefined;

function getNewTrackResponseSchema() {
  if (newTrackResponseSchema === undefined) {
    newTrackResponseSchema = createNewTrackResponseSchema();
  }

  return newTrackResponseSchema;
}

function createNewSessionResponseSchema() {
  return v.object({
    sessionId: v.string(),
  });
}

let newSessionResponseSchema:
  | ReturnType<typeof createNewSessionResponseSchema>
  | undefined;

function getNewSessionResponseSchema() {
  if (newSessionResponseSchema === undefined) {
    newSessionResponseSchema = createNewSessionResponseSchema();
  }

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
  | ReturnType<typeof createNewTracksResponseSchema>
  | undefined;

function getNewTracksResponseSchema() {
  if (newTracksResponseSchema === undefined) {
    newTracksResponseSchema = createNewTracksResponseSchema();
  }

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
  | ReturnType<typeof createCloseTrackResultSchema>
  | undefined;

function getCloseTrackResultSchema() {
  if (closeTrackResultSchema === undefined) {
    closeTrackResultSchema = createCloseTrackResultSchema();
  }

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
  | ReturnType<typeof createCloseTracksResponseSchema>
  | undefined;

function getCloseTracksResponseSchema() {
  if (closeTracksResponseSchema === undefined) {
    closeTracksResponseSchema = createCloseTracksResponseSchema();
  }

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

function isAbortError(error: Error): boolean {
  return error.name === "AbortError";
}

async function fetchSfu(
  endpoint: string,
  init: RequestInit,
): Promise<Result<Response, SfuFailure>> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, SFU_FETCH_TIMEOUT_MS);

  return fetch(endpoint, {
    ...init,
    signal: abortController.signal,
  })
    .then((response) => ok(response))
    .catch((error: Error) => {
      const kind: SfuApiErrorKind = isAbortError(error)
        ? "request_timeout"
        : "request_failed";
      return err({
        message: isAbortError(error)
          ? "SFU request timed out"
          : "SFU request failed",
        endpoint,
        kind,
        responseBody: error.message,
      });
    })
    .finally(() => {
      clearTimeout(timeoutId);
    });
}

function normalizeTrackLocator(track: TrackLocator): TrackLocatorRequest {
  return {
    location: track.location,
    sessionId: track.sessionId,
    trackName: track.trackName,
  };
}

async function readSfuJsonResponse(
  response: Response,
): Promise<Result<unknown, SfuFailure>> {
  if (!response.ok) {
    const responseBody = await response
      .json()
      .catch(() => response.text().catch(() => null));
    return err(
      sfuFailureFromHttpFailure(
        response.status,
        response.statusText,
        response.url,
        responseBody,
      ),
    );
  }

  return response
    .json()
    .then((responseBody: unknown) => ok(responseBody))
    .catch((error: Error) =>
      err({
        message: "Invalid SFU response JSON",
        endpoint: response.url,
        kind: "invalid_response_json",
        responseBody: {
          error: error.message,
        },
      }),
    );
}

/**
 * Create a Cloudflare Calls session.
 *
 * Ingest sessions are later persisted in D1. Playback sessions are per viewer
 * attempt and live only in the returned WHEP session URL.
 */
async function createSession(
  env: SfuEnv,
): Promise<Result<NewSessionResponse, SfuFailure>> {
  const endpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/new`;
  const responseResult = await fetchSfu(endpoint, {
    method: "POST",
    headers: getHeaders(env),
  });
  if (responseResult.isErr()) {
    return err(responseResult.error);
  }
  const responseBodyResult = await readSfuJsonResponse(responseResult.value);
  if (responseBodyResult.isErr()) {
    return err(responseBodyResult.error);
  }
  const responseBody = responseBodyResult.value;

  const parsedResponse = v.safeParse(
    getNewSessionResponseSchema(),
    responseBody,
  );
  if (!parsedResponse.success) {
    return err({
      message: "Invalid SFU response schema",
      endpoint,
      kind: "invalid_response_schema",
      responseBody: {
        issues: parsedResponse.issues,
        responseBody,
      },
    });
  }

  return ok(parsedResponse.output);
}

/**
 * Create ingest tracks from a WHIP offer.
 *
 * `autoDiscover` lets OBS offer its audio/video tracks without the Worker
 * predeclaring individual track names.
 */
async function createIngestTracks(
  env: SfuEnv,
  sessionId: string,
  sdpOffer: string,
): Promise<Result<NewTracksResponse, SfuFailure>> {
  const body = {
    sessionDescription: {
      type: "offer",
      sdp: sdpOffer,
    },
    autoDiscover: true,
  };

  const endpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionId}/tracks/new`;
  const responseResult = await fetchSfu(endpoint, {
    method: "POST",
    headers: {
      ...getHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (responseResult.isErr()) {
    return err(responseResult.error);
  }
  const responseBodyResult = await readSfuJsonResponse(responseResult.value);
  if (responseBodyResult.isErr()) {
    return err(responseBodyResult.error);
  }
  const responseBody = responseBodyResult.value;

  const parsedResponse = v.safeParse(
    getNewTracksResponseSchema(),
    responseBody,
  );
  if (!parsedResponse.success) {
    return err({
      message: "Invalid SFU response schema",
      endpoint,
      kind: "invalid_response_schema",
      responseBody: {
        issues: parsedResponse.issues,
        responseBody,
      },
    });
  }

  return ok(parsedResponse.output);
}

/**
 * Attach a playback session to stored ingest track locators.
 *
 * Passing an SDP offer lets Calls answer directly. Calls may also return a
 * counter-offer, which the WHEP route answers through `renegotiateSession`.
 */
async function connectToTracks(
  env: SfuEnv,
  sessionId: string,
  tracks: TrackLocator[],
  sdpOffer?: string,
): Promise<Result<NewTracksResponse, SfuFailure>> {
  const normalizedTracks = tracks.map(normalizeTrackLocator);
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
  const responseResult = await fetchSfu(endpoint, {
    method: "POST",
    headers: {
      ...getHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (responseResult.isErr()) {
    return err(responseResult.error);
  }
  const responseBodyResult = await readSfuJsonResponse(responseResult.value);
  if (responseBodyResult.isErr()) {
    return err(responseBodyResult.error);
  }
  const responseBody = responseBodyResult.value;

  const parsedResponseResult = v.safeParse(
    getNewTracksResponseSchema(),
    responseBody,
  );
  if (!parsedResponseResult.success) {
    return err({
      message: "Invalid SFU response schema",
      endpoint,
      kind: "invalid_response_schema",
      responseBody: {
        issues: parsedResponseResult.issues,
        responseBody,
      },
    });
  }
  const parsedResponse = parsedResponseResult.output;
  const hasTrackNegotiationErrors =
    !!parsedResponse.errorCode ||
    !!parsedResponse.errorDescription ||
    !!parsedResponse.tracks?.some((track) => !!track.errorCode);
  if (hasTrackNegotiationErrors) {
    return err({
      message: "SFU returned track negotiation errors",
      endpoint,
      kind: "track_negotiation_error",
      responseBody,
    });
  }
  return ok(parsedResponse);
}

/**
 * Submit the answer to a Calls counter-offer.
 *
 * This is not used for trickle ICE candidate PATCHes; the frontend gathers
 * complete SDP before POST/PATCH.
 */
export async function renegotiateSession(
  env: SfuEnv,
  sessionId: string,
  sdpAnswer: string,
): Promise<Result<Response, SfuApiError>> {
  const body = {
    sessionDescription: {
      type: "answer",
      sdp: sdpAnswer,
    },
  };

  const endpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionId}/renegotiate`;
  const responseResult = await fetchSfu(endpoint, {
    method: "PUT",
    headers: {
      ...getHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (responseResult.isErr()) {
    const failure = responseResult.error;
    return err(
      new SfuApiError(failure.message, {
        endpoint: failure.endpoint,
        kind: failure.kind,
        responseBody: failure.responseBody,
        statusText: failure.statusText,
      }),
    );
  }
  const response = responseResult.value;
  if (!response.ok) {
    const responseBody = await response
      .json()
      .catch(() => response.text().catch(() => null));
    const failure = sfuFailureFromHttpFailure(
      response.status,
      response.statusText,
      response.url,
      responseBody,
    );
    return err(
      new SfuApiError(failure.message, {
        endpoint: failure.endpoint,
        kind: failure.kind,
        responseBody: failure.responseBody,
        statusText: failure.statusText,
      }),
    );
  }

  return ok(response);
}

/**
 * Close tracks by mids that belong to one Calls session.
 *
 * Track mids are not stable across OBS reconnects or viewer sessions, so callers
 * must pass the mids from the exact session they are closing.
 */
export async function closeTracks(
  env: SfuEnv,
  sessionId: string,
  tracks: StoredTrack[],
): Promise<Result<CloseTracksResponse, SfuApiError>> {
  const body = {
    force: true,
    tracks: tracks.map((track) => ({
      mid: track.mid,
    })),
  };

  const endpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionId}/tracks/close`;
  const responseResult = await fetchSfu(endpoint, {
    method: "PUT",
    headers: {
      ...getHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (responseResult.isErr()) {
    const failure = responseResult.error;
    return err(
      new SfuApiError(failure.message, {
        endpoint: failure.endpoint,
        kind: failure.kind,
        responseBody: failure.responseBody,
        statusText: failure.statusText,
      }),
    );
  }
  const responseBodyResult = await readSfuJsonResponse(responseResult.value);
  if (responseBodyResult.isErr()) {
    const failure = responseBodyResult.error;
    return err(
      new SfuApiError(failure.message, {
        endpoint: failure.endpoint,
        kind: failure.kind,
        responseBody: failure.responseBody,
        statusText: failure.statusText,
      }),
    );
  }
  const responseBody = responseBodyResult.value;

  const parsedResponse = v.safeParse(
    getCloseTracksResponseSchema(),
    responseBody,
  );
  if (!parsedResponse.success) {
    return err(
      new SfuApiError("Invalid SFU response schema", {
        endpoint,
        kind: "invalid_response_schema",
        responseBody: {
          issues: parsedResponse.issues,
          responseBody,
        },
      }),
    );
  }

  return ok(parsedResponse.output);
}

/**
 * Probe one Calls session for targeted D1 reconciliation.
 *
 * Only 404/410 mean "inactive"; transient SFU failures should not be treated as
 * proof that a live row is stale.
 */
export async function isSessionActive(
  env: SfuEnv,
  sessionId: string,
): Promise<Result<boolean, SfuApiError>> {
  const endpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionId}`;
  const responseResult = await fetchSfu(endpoint, {
    method: "GET",
    headers: getHeaders(env),
  });
  if (responseResult.isErr()) {
    const failure = responseResult.error;
    return err(
      new SfuApiError(failure.message, {
        endpoint: failure.endpoint,
        kind: failure.kind,
        responseBody: failure.responseBody,
        statusText: failure.statusText,
      }),
    );
  }
  const response = responseResult.value;

  if (!response.ok) {
    const responseBody = await response
      .json()
      .catch(() => response.text().catch(() => null));
    const responseFailure = sfuFailureFromHttpFailure(
      response.status,
      response.statusText,
      endpoint,
      responseBody,
    );
    if (
      responseFailure.kind === "session_not_found" ||
      responseFailure.kind === "session_gone"
    ) {
      return ok(false);
    }
    return err(
      new SfuApiError(responseFailure.message, {
        endpoint: responseFailure.endpoint,
        kind: responseFailure.kind,
        responseBody: responseFailure.responseBody,
        statusText: responseFailure.statusText,
      }),
    );
  }

  return ok(true);
}

/**
 * Start one ingest session and return the SDP answer plus durable track locators.
 */
export async function startIngest(
  env: SfuEnv,
  _liveId: string,
  sdpOffer: string,
): Promise<
  Result<
    {
      sessionId: string;
      sdpAnswer: string;
      tracks: StoredTrack[];
    },
    SfuApiError
  >
> {
  const sessionResult = await createSession(env);
  if (sessionResult.isErr()) {
    const failure = sessionResult.error;
    return err(
      new SfuApiError(failure.message, {
        endpoint: failure.endpoint,
        kind: failure.kind,
        responseBody: failure.responseBody,
        statusText: failure.statusText,
      }),
    );
  }

  const tracksResult = await createIngestTracks(
    env,
    sessionResult.value.sessionId,
    sdpOffer,
  );
  if (tracksResult.isErr()) {
    const failure = tracksResult.error;
    return err(
      new SfuApiError(failure.message, {
        endpoint: failure.endpoint,
        kind: failure.kind,
        responseBody: failure.responseBody,
        statusText: failure.statusText,
      }),
    );
  }
  const ingestEndpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionResult.value.sessionId}/tracks/new`;
  const responseTracks = tracksResult.value.tracks;
  const sdpAnswer = tracksResult.value.sessionDescription?.sdp;

  if (!responseTracks || responseTracks.length === 0 || !sdpAnswer) {
    return err(
      new SfuApiError("SFU response did not include ingest tracks or SDP", {
        endpoint: ingestEndpoint,
        kind: "invalid_sfu_response",
        responseBody: tracksResult.value,
      }),
    );
  }
  if (responseTracks.length > WHIP_MAX_TRACK_COUNT) {
    // The supported OBS ingest shape is one audio track plus one video track.
    return err(
      new SfuApiError("WHIP does not allow more than two ingest tracks", {
        endpoint: ingestEndpoint,
        kind: "invalid_sfu_response",
        responseBody: tracksResult.value,
      }),
    );
  }

  const tracks = responseTracks.flatMap((track) =>
    typeof track.mid === "string"
      ? [
          {
            location: "remote",
            sessionId: sessionResult.value.sessionId,
            trackName: track.trackName,
            mid: track.mid,
          },
        ]
      : [],
  );
  if (tracks.length !== responseTracks.length) {
    return err(
      new SfuApiError("SFU response did not include track MID", {
        endpoint: ingestEndpoint,
        kind: "invalid_sfu_response",
        responseBody: tracksResult.value,
      }),
    );
  }

  return ok({
    sessionId: sessionResult.value.sessionId,
    sdpAnswer,
    tracks,
  });
}

/**
 * Start one viewer playback session for the stored ingest tracks.
 */
export async function startPlay(
  env: SfuEnv,
  liveId: string,
  tracks: TrackLocator[],
  sdpOffer?: string,
): Promise<
  Result<
    {
      sessionId: string;
      sdpAnswer: string;
      sdpType: "answer" | "offer";
      tracks: StoredTrack[];
    },
    SfuApiError | LiveNotFoundError
  >
> {
  if (tracks.length === 0) {
    return err(new LiveNotFoundError(liveId));
  }

  const sessionResult = await createSession(env);
  if (sessionResult.isErr()) {
    const failure = sessionResult.error;
    return err(
      new SfuApiError(failure.message, {
        endpoint: failure.endpoint,
        kind: failure.kind,
        responseBody: failure.responseBody,
        statusText: failure.statusText,
      }),
    );
  }

  const tracksResult = await connectToTracks(
    env,
    sessionResult.value.sessionId,
    tracks,
    sdpOffer,
  );
  if (tracksResult.isErr()) {
    const failure = tracksResult.error;
    return err(
      new SfuApiError(failure.message, {
        endpoint: failure.endpoint,
        kind: failure.kind,
        responseBody: failure.responseBody,
        statusText: failure.statusText,
      }),
    );
  }
  const sdpAnswer = tracksResult.value.sessionDescription?.sdp;
  const sdpType = tracksResult.value.sessionDescription?.type;
  const responseTracks = tracksResult.value.tracks;
  const playbackEndpoint = `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}/sessions/${sessionResult.value.sessionId}/tracks/new`;
  if (!sdpAnswer) {
    return err(
      new SfuApiError("SFU response did not include SDP for playback", {
        endpoint: playbackEndpoint,
        kind: "invalid_sfu_response",
        responseBody: tracksResult.value,
      }),
    );
  }
  if (!responseTracks || responseTracks.length === 0) {
    return err(
      new SfuApiError("SFU response did not include playback tracks", {
        endpoint: playbackEndpoint,
        kind: "invalid_sfu_response",
        responseBody: tracksResult.value,
      }),
    );
  }
  if (sdpType !== "answer" && sdpType !== "offer") {
    return err(
      new SfuApiError(
        "SFU response did not include valid SDP type for playback",
        {
          endpoint: playbackEndpoint,
          kind: "invalid_sfu_response",
          responseBody: tracksResult.value,
        },
      ),
    );
  }

  const playbackTracks = responseTracks.flatMap((track) =>
    typeof track.mid === "string"
      ? [
          {
            location: "remote",
            mid: track.mid,
            sessionId: sessionResult.value.sessionId,
            trackName: track.trackName,
          },
        ]
      : [],
  );
  if (playbackTracks.length !== responseTracks.length) {
    return err(
      new SfuApiError("SFU response did not include playback track MID", {
        endpoint: playbackEndpoint,
        kind: "invalid_sfu_response",
        responseBody: tracksResult.value,
      }),
    );
  }

  return ok({
    sessionId: sessionResult.value.sessionId,
    sdpAnswer,
    sdpType,
    tracks: playbackTracks,
  });
}
