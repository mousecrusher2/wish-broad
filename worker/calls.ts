import {
  Bindings,
  CloseTracksResponse,
  NewSessionResponse,
  NewTracksResponse,
  StoredTrack,
  TrackLocator,
} from "./types";
import {
  parseCloseTracksResponse,
  parseNewSessionResponse,
  parseNewTracksResponse,
  SchemaValidationError,
} from "./validation";

// カスタムエラークラス
export class CallsApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly endpoint: string,
    public readonly responseBody?: unknown,
  ) {
    super(
      `Calls API Error: ${String(statusCode)} ${statusText} at ${endpoint}`,
    );
    this.name = "CallsApiError";
  }
}

export class LiveNotFoundError extends Error {
  constructor(liveId: string) {
    super(`Live stream not found: ${liveId}`);
    this.name = "LiveNotFoundError";
  }
}

// レスポンスチェック用ユーティリティ
async function checkCallsApiResponse(
  response: Response,
  endpoint: string,
): Promise<void> {
  if (!response.ok) {
    let responseBody;
    try {
      responseBody = await response.json();
    } catch {
      // JSONパースに失敗した場合はテキストで取得を試行
      try {
        responseBody = await response.text();
      } catch {
        responseBody = null;
      }
    }

    throw new CallsApiError(
      response.status,
      response.statusText,
      endpoint,
      responseBody,
    );
  }
}

type CallsEnv = Pick<Bindings, "CALLS_APP_ID" | "CALLS_APP_SECRET">;
type TrackLocatorRequest = Pick<
  TrackLocator,
  "location" | "sessionId" | "trackName"
>;

function getEndpoint(env: CallsEnv, path: string): string {
  return `https://rtc.live.cloudflare.com/v1/apps/${env.CALLS_APP_ID}${path}`;
}

function getHeaders(env: CallsEnv): Record<string, string> {
  return {
    Authorization: `Bearer ${env.CALLS_APP_SECRET}`,
  };
}

function normalizeTrackLocator(track: TrackLocator): TrackLocatorRequest {
  return {
    location: track.location,
    sessionId: track.sessionId,
    trackName: track.trackName,
  };
}

function isInactiveSessionError(error: unknown): boolean {
  return (
    error instanceof CallsApiError &&
    (error.statusCode === 404 || error.statusCode === 410)
  );
}

function hasTracksResponseErrors(response: NewTracksResponse): boolean {
  if (response.errorCode || response.errorDescription) {
    return true;
  }

  return !!response.tracks?.some((track) => track.errorCode);
}

function parseNewTracksOrThrow(
  responseBody: unknown,
  endpoint: string,
  source: string,
): NewTracksResponse {
  try {
    return parseNewTracksResponse(responseBody, source);
  } catch (error) {
    if (error instanceof SchemaValidationError) {
      throw new CallsApiError(
        502,
        "Invalid Calls response schema",
        endpoint,
        responseBody,
      );
    }
    throw error;
  }
}

/**
 * 新しいセッションを作成
 */
export async function createSession(
  env: CallsEnv,
): Promise<NewSessionResponse> {
  const endpoint = getEndpoint(env, "/sessions/new");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: getHeaders(env),
  });

  await checkCallsApiResponse(response, endpoint);
  const responseBody: unknown = await response.json();
  return parseNewSessionResponse(responseBody, "Calls createSession response");
}

/**
 * 配信者用：新しいトラックを作成（WHIP）
 */
export async function createIngestTracks(
  env: CallsEnv,
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

  const endpoint = getEndpoint(env, `/sessions/${sessionId}/tracks/new`);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...getHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  await checkCallsApiResponse(response, endpoint);
  const responseBody: unknown = await response.json();
  return parseNewTracksOrThrow(
    responseBody,
    endpoint,
    "Calls createIngestTracks response",
  );
}

/**
 * 視聴者用：既存のトラックに接続（WHEP）
 */
export async function connectToTracks(
  env: CallsEnv,
  sessionId: string,
  tracks: TrackLocator[],
  sdpOffer?: string,
): Promise<NewTracksResponse> {
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
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      ...getHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  await checkCallsApiResponse(response, endpoint);
  const responseBody: unknown = await response.json();
  const parsedResponse = parseNewTracksOrThrow(
    responseBody,
    endpoint,
    "Calls connectToTracks response",
  );
  if (hasTracksResponseErrors(parsedResponse)) {
    throw new CallsApiError(
      502,
      "Calls returned track negotiation errors",
      endpoint,
      responseBody,
    );
  }
  return parsedResponse;
}

/**
 * セッション再交渉（ICE候補やセッション再交渉用）
 */
export async function renegotiateSession(
  env: CallsEnv,
  sessionId: string,
  sdpAnswer: string,
): Promise<Response> {
  const body = {
    sessionDescription: {
      type: "answer",
      sdp: sdpAnswer,
    },
  };

  const endpoint = getEndpoint(env, `/sessions/${sessionId}/renegotiate`);
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      ...getHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  await checkCallsApiResponse(response, endpoint);
  return response;
}

/**
 * セッションに紐づくトラックを閉じる
 */
export async function closeTracks(
  env: CallsEnv,
  sessionId: string,
  tracks: StoredTrack[],
): Promise<CloseTracksResponse> {
  const body = {
    force: true,
    tracks: tracks.map((track) => ({
      mid: track.mid,
    })),
  };

  const endpoint = getEndpoint(env, `/sessions/${sessionId}/tracks/close`);
  const response = await fetch(endpoint, {
    method: "PUT",
    headers: {
      ...getHeaders(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  await checkCallsApiResponse(response, endpoint);
  const responseBody: unknown = await response.json();
  return parseCloseTracksResponse(responseBody, "Calls closeTracks response");
}

/**
 * セッションが継続しているか確認
 */
export async function isSessionActive(
  env: CallsEnv,
  sessionId: string,
): Promise<boolean> {
  const endpoint = getEndpoint(env, `/sessions/${sessionId}`);
  const response = await fetch(endpoint, {
    method: "GET",
    headers: getHeaders(env),
  });

  try {
    await checkCallsApiResponse(response, endpoint);
    return true; // ステータスコード200ならセッションはアクティブ
  } catch (error) {
    if (isInactiveSessionError(error)) {
      return false; // セッションが見つからない場合は非アクティブ
    }
    throw error; // その他のエラーは再スロー
  }
}

/**
 * 配信開始処理：SDP Offerを受け取り、Cloudflareセッションを作成してトラック情報を返す
 */
export async function startIngest(
  env: CallsEnv,
  _liveId: string,
  sdpOffer: string,
): Promise<{
  sessionId: string;
  sdpAnswer: string;
  tracks: StoredTrack[];
}> {
  // 新しいセッションを作成
  const sessionResult = await createSession(env);

  // 配信者からのSDP Offerを使ってトラックを作成
  const tracksResult = await createIngestTracks(
    env,
    sessionResult.sessionId,
    sdpOffer,
  );
  const ingestEndpoint = getEndpoint(
    env,
    `/sessions/${sessionResult.sessionId}/tracks/new`,
  );
  const responseTracks = tracksResult.tracks;
  const sdpAnswer = tracksResult.sessionDescription?.sdp;

  if (!responseTracks || responseTracks.length === 0 || !sdpAnswer) {
    throw new CallsApiError(
      502,
      "Calls response did not include ingest tracks or SDP",
      ingestEndpoint,
      tracksResult,
    );
  }

  // トラック情報を整理
  const tracks = responseTracks.map((track) => {
    if (!track.mid) {
      throw new CallsApiError(
        502,
        "Calls response did not include track MID",
        ingestEndpoint,
        tracksResult,
      );
    }

    return {
      location: "remote" as const,
      sessionId: sessionResult.sessionId,
      trackName: track.trackName,
      mid: track.mid,
    };
  });

  return {
    sessionId: sessionResult.sessionId,
    sdpAnswer,
    tracks,
  };
}

/**
 * 視聴開始処理：既存のトラックに接続して視聴セッションを作成
 */
export async function startPlay(
  env: CallsEnv,
  liveId: string,
  tracks: TrackLocator[],
  sdpOffer?: string,
): Promise<{
  sessionId: string;
  sdpAnswer: string;
  sdpType: "answer" | "offer";
  tracks: StoredTrack[];
}> {
  if (tracks.length === 0) {
    throw new LiveNotFoundError(liveId);
  }

  // 新しい視聴セッションを作成
  const sessionResult = await createSession(env);

  // 既存のトラックに接続
  const tracksResult = await connectToTracks(
    env,
    sessionResult.sessionId,
    tracks,
    sdpOffer,
  );
  const sdpAnswer = tracksResult.sessionDescription?.sdp;
  const sdpType = tracksResult.sessionDescription?.type;
  const responseTracks = tracksResult.tracks;
  if (!sdpAnswer) {
    throw new CallsApiError(
      502,
      "Calls response did not include SDP for playback",
      getEndpoint(env, `/sessions/${sessionResult.sessionId}/tracks/new`),
      tracksResult,
    );
  }
  if (!responseTracks || responseTracks.length === 0) {
    throw new CallsApiError(
      502,
      "Calls response did not include playback tracks",
      getEndpoint(env, `/sessions/${sessionResult.sessionId}/tracks/new`),
      tracksResult,
    );
  }
  if (sdpType !== "answer" && sdpType !== "offer") {
    throw new CallsApiError(
      502,
      "Calls response did not include valid SDP type for playback",
      getEndpoint(env, `/sessions/${sessionResult.sessionId}/tracks/new`),
      tracksResult,
    );
  }

  const playbackTracks = responseTracks.map((track) => {
    if (!track.mid) {
      throw new CallsApiError(
        502,
        "Calls response did not include playback track MID",
        getEndpoint(env, `/sessions/${sessionResult.sessionId}/tracks/new`),
        tracksResult,
      );
    }

    return {
      location: "remote" as const,
      mid: track.mid,
      sessionId: sessionResult.sessionId,
      trackName: track.trackName,
    };
  });

  return {
    sessionId: sessionResult.sessionId,
    sdpAnswer,
    sdpType,
    tracks: playbackTracks,
  };
}
