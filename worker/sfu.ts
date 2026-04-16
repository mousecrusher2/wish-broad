import { Bindings } from "./types";
import { err, ok, type Result } from "neverthrow";
import * as v from "valibot";

export type SessionDescription = {
  sdp: string;
  type: string;
};

export type NewSessionResponse = {
  sessionId: string;
};

export type NewTrackResponse = {
  trackName: string;
  mid?: string | undefined;
  sessionId?: string | undefined;
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
};

export type NewTracksResponse = {
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

export type ClosedTrack = {
  mid: string;
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
  sessionId?: string | undefined;
  trackName?: string | undefined;
};

export type CloseTracksResponse = {
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
  requiresImmediateRenegotiation?: boolean | undefined;
  sessionDescription?: SessionDescription | undefined;
  tracks?: ClosedTrack[] | undefined;
};

type SfuNegotiationClientStatus = 400 | 415 | 422;

type SfuApiErrorKind =
  | "request_failed"
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

// カスタムエラークラス
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
      statusText?: string;
    },
  ) {
    super(message);
    this.name = "SfuApiError";
    this.endpoint = options.endpoint;
    this.kind = options.kind;
    this.responseBody = options.responseBody;
    this.statusText = options.statusText;
  }

  static fromHttpFailure(
    status: number,
    statusText: string,
    endpoint: string,
    responseBody?: unknown,
  ): SfuApiError {
    if (status === 400) {
      return new SfuApiError("SFU request failed: bad request", {
        endpoint,
        kind: "bad_request",
        responseBody,
        statusText,
      });
    }
    if (status === 404) {
      return new SfuApiError("SFU request failed: session not found", {
        endpoint,
        kind: "session_not_found",
        responseBody,
        statusText,
      });
    }
    if (status === 410) {
      return new SfuApiError("SFU request failed: session gone", {
        endpoint,
        kind: "session_gone",
        responseBody,
        statusText,
      });
    }
    if (status === 415) {
      return new SfuApiError("SFU request failed: unsupported media type", {
        endpoint,
        kind: "unsupported_media_type",
        responseBody,
        statusText,
      });
    }
    if (status === 422) {
      return new SfuApiError("SFU request failed: unprocessable content", {
        endpoint,
        kind: "unprocessable_content",
        responseBody,
        statusText,
      });
    }

    return new SfuApiError("SFU request failed", {
      endpoint,
      kind: "http_error",
      responseBody,
      statusText,
    });
  }

  isInactiveSession(): boolean {
    return this.kind === "session_not_found" || this.kind === "session_gone";
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

    return null;
  }
}

export class LiveNotFoundError extends Error {
  constructor(liveId: string) {
    super(`Live stream not found: ${liveId}`);
    this.name = "LiveNotFoundError";
  }
}

const sessionDescriptionSchema = v.object({
  sdp: v.string(),
  type: v.string(),
});

const newTrackResponseSchema = v.object({
  trackName: v.string(),
  mid: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  errorCode: v.optional(v.string()),
  errorDescription: v.optional(v.string()),
});

const newSessionResponseSchema = v.object({
  sessionId: v.string(),
});

const newTracksResponseSchema = v.object({
  errorCode: v.optional(v.string()),
  errorDescription: v.optional(v.string()),
  requiresImmediateRenegotiation: v.optional(v.boolean()),
  tracks: v.optional(v.array(newTrackResponseSchema)),
  sessionDescription: v.optional(sessionDescriptionSchema),
});

const closeTrackResultSchema = v.object({
  mid: v.string(),
  errorCode: v.optional(v.string()),
  errorDescription: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  trackName: v.optional(v.string()),
});

const closeTracksResponseSchema = v.object({
  errorCode: v.optional(v.string()),
  errorDescription: v.optional(v.string()),
  requiresImmediateRenegotiation: v.optional(v.boolean()),
  sessionDescription: v.optional(sessionDescriptionSchema),
  tracks: v.optional(v.array(closeTrackResultSchema)),
});

type SfuEnv = Pick<Bindings, "CALLS_APP_ID" | "CALLS_APP_SECRET">;
type TrackLocatorRequest = Pick<
  TrackLocator,
  "location" | "sessionId" | "trackName"
>;

function getEndpoint(env: SfuEnv, path: string): string {
  return `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}${path}`;
}

function getHeaders(env: SfuEnv): Record<string, string> {
  return {
    Authorization: `Bearer ${env.CALLS_APP_SECRET}`,
  };
}

async function fetchSfu(
  endpoint: string,
  init: RequestInit,
): Promise<Result<Response, SfuApiError>> {
  return fetch(endpoint, init)
    .then((response) => ok(response))
    .catch((error: Error) =>
      err(
        new SfuApiError("SFU request failed", {
          endpoint,
          kind: "request_failed",
          responseBody: error.message,
        }),
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
 * 新しいセッションを作成
 */
export async function createSession(
  env: SfuEnv,
): Promise<Result<NewSessionResponse, SfuApiError>> {
  const endpoint = getEndpoint(env, "/sessions/new");
  const responseResult = await fetchSfu(endpoint, {
    method: "POST",
    headers: getHeaders(env),
  });
  if (responseResult.isErr()) {
    return err(responseResult.error);
  }
  const response = responseResult.value;

  if (!response.ok) {
    const responseBody = await response
      .json()
      .catch(() => response.text().catch(() => null));
    return err(
      SfuApiError.fromHttpFailure(
        response.status,
        response.statusText,
        endpoint,
        responseBody,
      ),
    );
  }

  const responseBodyResult = await response
    .json()
    .then((responseBody: unknown) => ok(responseBody))
    .catch((error: Error) =>
      err(
        new SfuApiError("Invalid SFU response JSON", {
          endpoint,
          kind: "invalid_response_json",
          responseBody: {
            error: error.message,
          },
        }),
      ),
    );
  if (responseBodyResult.isErr()) {
    return err(responseBodyResult.error);
  }
  const responseBody = responseBodyResult.value;

  const parsedResponse = v.safeParse(
    newSessionResponseSchema,
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
 * 配信者用：新しいトラックを作成（WHIP）
 */
export async function createIngestTracks(
  env: SfuEnv,
  sessionId: string,
  sdpOffer: string,
): Promise<Result<NewTracksResponse, SfuApiError>> {
  const body = {
    sessionDescription: {
      type: "offer",
      sdp: sdpOffer,
    },
    autoDiscover: true,
  };

  const endpoint = getEndpoint(env, `/sessions/${sessionId}/tracks/new`);
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
  const response = responseResult.value;

  if (!response.ok) {
    const responseBody = await response
      .json()
      .catch(() => response.text().catch(() => null));
    return err(
      SfuApiError.fromHttpFailure(
        response.status,
        response.statusText,
        endpoint,
        responseBody,
      ),
    );
  }

  const responseBodyResult = await response
    .json()
    .then((responseBody: unknown) => ok(responseBody))
    .catch((error: Error) =>
      err(
        new SfuApiError("Invalid SFU response JSON", {
          endpoint,
          kind: "invalid_response_json",
          responseBody: {
            error: error.message,
          },
        }),
      ),
    );
  if (responseBodyResult.isErr()) {
    return err(responseBodyResult.error);
  }
  const responseBody = responseBodyResult.value;

  const parsedResponse = v.safeParse(newTracksResponseSchema, responseBody);
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
 * 視聴者用：既存のトラックに接続（WHEP）
 */
export async function connectToTracks(
  env: SfuEnv,
  sessionId: string,
  tracks: TrackLocator[],
  sdpOffer?: string,
): Promise<Result<NewTracksResponse, SfuApiError>> {
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

  const endpoint = getEndpoint(env, `/sessions/${sessionId}/tracks/new`);
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
  const response = responseResult.value;

  if (!response.ok) {
    const responseBody = await response
      .json()
      .catch(() => response.text().catch(() => null));
    return err(
      SfuApiError.fromHttpFailure(
        response.status,
        response.statusText,
        endpoint,
        responseBody,
      ),
    );
  }

  const responseBodyResult = await response
    .json()
    .then((responseBody: unknown) => ok(responseBody))
    .catch((error: Error) =>
      err(
        new SfuApiError("Invalid SFU response JSON", {
          endpoint,
          kind: "invalid_response_json",
          responseBody: {
            error: error.message,
          },
        }),
      ),
    );
  if (responseBodyResult.isErr()) {
    return err(responseBodyResult.error);
  }
  const responseBody = responseBodyResult.value;

  const parsedResponseResult = v.safeParse(newTracksResponseSchema, responseBody);
  if (!parsedResponseResult.success) {
    return err(
      new SfuApiError("Invalid SFU response schema", {
        endpoint,
        kind: "invalid_response_schema",
        responseBody: {
          issues: parsedResponseResult.issues,
          responseBody,
        },
      }),
    );
  }
  const parsedResponse = parsedResponseResult.output;
  const hasTrackNegotiationErrors =
    !!parsedResponse.errorCode ||
    !!parsedResponse.errorDescription ||
    !!parsedResponse.tracks?.some((track) => !!track.errorCode);
  if (hasTrackNegotiationErrors) {
    return err(
      new SfuApiError("SFU returned track negotiation errors", {
        endpoint,
        kind: "track_negotiation_error",
        responseBody,
      }),
    );
  }
  return ok(parsedResponse);
}

/**
 * セッション再交渉（ICE候補やセッション再交渉用）
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

  const endpoint = getEndpoint(env, `/sessions/${sessionId}/renegotiate`);
  const responseResult = await fetchSfu(endpoint, {
    method: "PUT",
    headers: {
      ...getHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (responseResult.isErr()) {
    return err(responseResult.error);
  }
  const response = responseResult.value;

  if (!response.ok) {
    const responseBody = await response
      .json()
      .catch(() => response.text().catch(() => null));
    return err(
      SfuApiError.fromHttpFailure(
        response.status,
        response.statusText,
        endpoint,
        responseBody,
      ),
    );
  }

  return ok(response);
}

/**
 * セッションに紐づくトラックを閉じる
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

  const endpoint = getEndpoint(env, `/sessions/${sessionId}/tracks/close`);
  const responseResult = await fetchSfu(endpoint, {
    method: "PUT",
    headers: {
      ...getHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (responseResult.isErr()) {
    return err(responseResult.error);
  }
  const response = responseResult.value;

  if (!response.ok) {
    const responseBody = await response
      .json()
      .catch(() => response.text().catch(() => null));
    return err(
      SfuApiError.fromHttpFailure(
        response.status,
        response.statusText,
        endpoint,
        responseBody,
      ),
    );
  }

  const responseBodyResult = await response
    .json()
    .then((responseBody: unknown) => ok(responseBody))
    .catch((error: Error) =>
      err(
        new SfuApiError("Invalid SFU response JSON", {
          endpoint,
          kind: "invalid_response_json",
          responseBody: {
            error: error.message,
          },
        }),
      ),
    );
  if (responseBodyResult.isErr()) {
    return err(responseBodyResult.error);
  }
  const responseBody = responseBodyResult.value;

  const parsedResponse = v.safeParse(closeTracksResponseSchema, responseBody);
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
 * セッションが継続しているか確認
 */
export async function isSessionActive(
  env: SfuEnv,
  sessionId: string,
): Promise<Result<boolean, SfuApiError>> {
  const endpoint = getEndpoint(env, `/sessions/${sessionId}`);
  const responseResult = await fetchSfu(endpoint, {
    method: "GET",
    headers: getHeaders(env),
  });
  if (responseResult.isErr()) {
    return err(responseResult.error);
  }
  const response = responseResult.value;

  if (!response.ok) {
    const responseBody = await response
      .json()
      .catch(() => response.text().catch(() => null));
    const responseError = SfuApiError.fromHttpFailure(
      response.status,
      response.statusText,
      endpoint,
      responseBody,
    );
    if (responseError.isInactiveSession()) {
      return ok(false);
    }
    return err(responseError);
  }

  return ok(true); // ステータスコード200ならセッションはアクティブ
}

/**
 * 配信開始処理：SDP Offerを受け取り、Cloudflareセッションを作成してトラック情報を返す
 */
export async function startIngest(
  env: SfuEnv,
  _liveId: string,
  sdpOffer: string,
): Promise<
  Result<{
    sessionId: string;
    sdpAnswer: string;
    tracks: StoredTrack[];
  }, SfuApiError>
> {
  // 新しいセッションを作成
  const sessionResult = await createSession(env);
  if (sessionResult.isErr()) {
    return err(sessionResult.error);
  }

  // 配信者からのSDP Offerを使ってトラックを作成
  const tracksResult = await createIngestTracks(
    env,
    sessionResult.value.sessionId,
    sdpOffer,
  );
  if (tracksResult.isErr()) {
    return err(tracksResult.error);
  }
  const ingestEndpoint = getEndpoint(
    env,
    `/sessions/${sessionResult.value.sessionId}/tracks/new`,
  );
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
 * 視聴開始処理：既存のトラックに接続して視聴セッションを作成
 */
export async function startPlay(
  env: SfuEnv,
  liveId: string,
  tracks: TrackLocator[],
  sdpOffer?: string,
): Promise<
  Result<{
    sessionId: string;
    sdpAnswer: string;
    sdpType: "answer" | "offer";
    tracks: StoredTrack[];
  }, SfuApiError | LiveNotFoundError>
> {
  if (tracks.length === 0) {
    return err(new LiveNotFoundError(liveId));
  }

  // 新しい視聴セッションを作成
  const sessionResult = await createSession(env);
  if (sessionResult.isErr()) {
    return err(sessionResult.error);
  }

  // 既存のトラックに接続
  const tracksResult = await connectToTracks(
    env,
    sessionResult.value.sessionId,
    tracks,
    sdpOffer,
  );
  if (tracksResult.isErr()) {
    return err(tracksResult.error);
  }
  const sdpAnswer = tracksResult.value.sessionDescription?.sdp;
  const sdpType = tracksResult.value.sessionDescription?.type;
  const responseTracks = tracksResult.value.tracks;
  const playbackEndpoint = getEndpoint(
    env,
    `/sessions/${sessionResult.value.sessionId}/tracks/new`,
  );
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
