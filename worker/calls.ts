import { NewSessionResponse, NewTracksResponse, TrackLocator } from "./types";

// カスタムエラークラス
export class CallsApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly statusText: string,
    public readonly endpoint: string,
    public readonly responseBody?: unknown
  ) {
    super(`Calls API Error: ${statusCode} ${statusText} at ${endpoint}`);
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
  endpoint: string
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
      responseBody
    );
  }
}

export interface CallsConfig {
  appId: string;
  appSecret: string;
}

export class CallsClient {
  private endpoint: string;
  private headers: Record<string, string>;

  constructor(config: CallsConfig) {
    this.endpoint = `https://rtc.live.cloudflare.com/v1/apps/${config.appId}`;
    this.headers = {
      Authorization: `Bearer ${config.appSecret}`,
    };
  }
  /**
   * 新しいセッションを作成
   */
  async createSession(): Promise<NewSessionResponse> {
    const endpoint = `${this.endpoint}/sessions/new`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: this.headers,
    });

    await checkCallsApiResponse(response, endpoint);
    return response.json() as Promise<NewSessionResponse>;
  }
  /**
   * 配信者用：新しいトラックを作成（WHIP）
   */
  async createIngestTracks(
    sessionId: string,
    sdpOffer: string
  ): Promise<NewTracksResponse> {
    const body = {
      sessionDescription: {
        type: "offer",
        sdp: sdpOffer,
      },
      autoDiscover: true,
    };

    const endpoint = `${this.endpoint}/sessions/${sessionId}/tracks/new`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    await checkCallsApiResponse(response, endpoint);
    return response.json() as Promise<NewTracksResponse>;
  }
  /**
   * 視聴者用：既存のトラックに接続（WHEP）
   */
  async connectToTracks(
    sessionId: string,
    tracks: TrackLocator[],
    sdpOffer?: string
  ): Promise<NewTracksResponse> {
    const body = sdpOffer && sdpOffer.length > 0 ? {
      sessionDescription: {
        type: "offer",
        sdp: sdpOffer,
      },
      tracks: tracks,
    } : {
      tracks: tracks,
    }

    const endpoint = `${this.endpoint}/sessions/${sessionId}/tracks/new`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    await checkCallsApiResponse(response, endpoint);
    return response.json() as Promise<NewTracksResponse>;
  }
  /**
   * セッション再交渉（ICE候補やセッション再交渉用）
   */
  async renegotiateSession(
    sessionId: string,
    sdpAnswer: string
  ): Promise<Response> {
    const body = {
      sessionDescription: {
        type: "answer",
        sdp: sdpAnswer,
      },
    };

    const endpoint = `${this.endpoint}/sessions/${sessionId}/renegotiate`;
    const response = await fetch(endpoint, {
      method: "PUT",
      headers: {
        ...this.headers,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    await checkCallsApiResponse(response, endpoint);
    return response;
  } /**
   * セッションが継続しているか確認
   */
  async isSessionActive(sessionId: string): Promise<boolean> {
    const endpoint = `${this.endpoint}/sessions/${sessionId}`;
    const response = await fetch(endpoint, {
      method: "GET",
      headers: this.headers,
    });

    try {
      await checkCallsApiResponse(response, endpoint);
      return true; // ステータスコード200ならセッションはアクティブ
    } catch (error) {
      if (error instanceof CallsApiError && error.statusCode === 404) {
        return false; // セッションが見つからない場合は非アクティブ
      }
      throw error; // その他のエラーは再スロー
    }
  }
}

/**
 * 配信開始処理：SDP Offerを受け取り、Cloudflareセッションを作成してトラック情報を返す
 */
export async function startIngest(
  callsClient: CallsClient,
  _liveId: string,
  sdpOffer: string
): Promise<{
  sessionId: string;
  sdpAnswer: string;
  tracks: TrackLocator[];
}> {
  // 新しいセッションを作成
  const sessionResult = await callsClient.createSession();

  // 配信者からのSDP Offerを使ってトラックを作成
  const tracksResult = await callsClient.createIngestTracks(
    sessionResult.sessionId,
    sdpOffer
  );

  // トラック情報を整理
  const tracks = tracksResult.tracks.map((track) => ({
    location: "remote" as const,
    sessionId: sessionResult.sessionId,
    trackName: track.trackName,
  }));

  return {
    sessionId: sessionResult.sessionId,
    sdpAnswer: tracksResult.sessionDescription.sdp,
    tracks,
  };
}

/**
 * 視聴開始処理：既存のトラックに接続して視聴セッションを作成
 */
export async function startPlay(
  callsClient: CallsClient,
  liveId: string,
  tracks: TrackLocator[],
  sdpOffer?: string
): Promise<{
  sessionId: string;
  sdpAnswer: string;
}> {
  if (tracks.length === 0) {
    throw new LiveNotFoundError(liveId);
  }

  // 新しい視聴セッションを作成
  const sessionResult = await callsClient.createSession();

  // 既存のトラックに接続
  const tracksResult = await callsClient.connectToTracks(
    sessionResult.sessionId,
    tracks,
    sdpOffer
  );
  return {
    sessionId: sessionResult.sessionId,
    sdpAnswer: tracksResult.sessionDescription.sdp,
  };
}
