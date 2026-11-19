// Worker の /play エンドポイントとの WHEP シグナリング（POST・PATCH）と、その応答の解析。
import { LIVE_TRACK_COUNT_HEADER } from "../../shared/protocol";

type WHEPSessionRequestStage = "post" | "patch" | "local";

type WHEPSessionErrorKind =
  | "resource_not_found"
  | "session_not_found"
  | "resource_unavailable"
  | "client_request_error"
  | "server_request_error"
  | "unexpected_response"
  | "invalid_sdp_response"
  | "missing_session_location"
  | "aborted";

type WHEPSessionErrorOptions = {
  kind: WHEPSessionErrorKind;
  responseText: string | undefined;
  retryable?: boolean;
  stage: WHEPSessionRequestStage;
};

/**
 * POST /play の応答。`counterOffer` は 406 のカウンターオファーで、PATCH でアンサーを返す。
 * `expectedRemoteTrackCount` は Worker がトラック数のヘッダーを返さなかった場合に null。
 */
export type WHEPOfferResponse = {
  expectedRemoteTrackCount: number | null;
  kind: "accepted" | "counterOffer";
  sdp: string;
  sessionUrl: URL;
};

export class WHEPSessionError extends Error {
  readonly kind: WHEPSessionErrorKind;
  readonly responseText: string | undefined;
  readonly retryable: boolean;
  readonly stage: WHEPSessionRequestStage;

  constructor(message: string, options: WHEPSessionErrorOptions) {
    super(message);
    this.name = "WHEPSessionError";
    this.kind = options.kind;
    this.responseText = options.responseText;
    this.retryable = options.retryable ?? true;
    this.stage = options.stage;
  }

  /** 配信が終了している（POST /play が 404 を返した）場合に true を返す。 */
  isNotFound(): boolean {
    return this.kind === "resource_not_found";
  }

  /** 配信者の再接続待ちで再生できない（Worker が 409 を返した）場合に true を返す。 */
  isUnavailable(): boolean {
    return this.kind === "resource_unavailable";
  }

  isClientRequestError(): boolean {
    return (
      this.kind === "resource_not_found" || this.kind === "client_request_error"
    );
  }
}

const SDP_REQUEST_HEADERS = {
  Accept: "application/sdp",
  "Content-Type": "application/sdp",
};

async function readResponseText(
  response: Response,
): Promise<string | undefined> {
  return response
    .text()
    .then((responseText) =>
      responseText.trim().length > 0 ? responseText : undefined,
    )
    .catch(() => undefined);
}

async function createResponseError(
  response: Response,
  fallbackMessage: string,
  stage: WHEPSessionRequestStage,
): Promise<WHEPSessionError> {
  const responseText = await readResponseText(response);
  let kind: WHEPSessionErrorKind = "unexpected_response";
  if (response.status === 404) {
    // 配信終了を表すのは POST の 404 だけ。PATCH の 404 はそのセッション URL を使えないことを表す。
    kind = stage === "post" ? "resource_not_found" : "session_not_found";
  } else if (response.status === 409) {
    kind = "resource_unavailable";
  } else if (response.status >= 400 && response.status < 500) {
    kind = "client_request_error";
  } else if (response.status >= 500) {
    kind = "server_request_error";
  }

  return new WHEPSessionError(responseText ?? fallbackMessage, {
    kind,
    responseText,
    stage,
  });
}

/**
 * @throws {WHEPSessionError} レスポンスが空でない SDP ボディでない場合。
 */
async function readSdpResponse(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("application/sdp")) {
    throw new WHEPSessionError("Unexpected WHEP SDP response content type", {
      kind: "invalid_sdp_response",
      responseText: undefined,
      retryable: false,
      stage: "post",
    });
  }

  const sdp = await response.text();
  if (sdp.trim().length === 0) {
    throw new WHEPSessionError("Empty SDP response", {
      kind: "invalid_sdp_response",
      responseText: undefined,
      retryable: false,
      stage: "post",
    });
  }

  return sdp;
}

/**
 * @throws {WHEPSessionError} トラック数ヘッダーが 1 以上の整数でない場合。
 */
function readExpectedRemoteTrackCount(response: Response): number | null {
  const header = response.headers.get(LIVE_TRACK_COUNT_HEADER);
  if (header === null) {
    return null;
  }

  const count = Number.parseInt(header, 10);
  if (!Number.isInteger(count) || count < 1) {
    throw new WHEPSessionError(`Invalid ${LIVE_TRACK_COUNT_HEADER} header`, {
      kind: "unexpected_response",
      responseText: header,
      retryable: false,
      stage: "post",
    });
  }
  return count;
}

/**
 * @throws {WHEPSessionError} location ヘッダー、有効なトラック数ヘッダー、および
 * SDP ボディを備えた 201 または 406 セッションレスポンスでない場合。
 */
async function parseOfferResponse(
  response: Response,
  resourceUrl: URL,
): Promise<WHEPOfferResponse> {
  if (response.status !== 201 && response.status !== 406) {
    throw await createResponseError(
      response,
      `Unexpected WHEP session response: ${String(response.status)}`,
      "post",
    );
  }

  const sessionLocation = response.headers.get("location");
  if (!sessionLocation) {
    throw new WHEPSessionError("Missing WHEP session location header", {
      kind: "missing_session_location",
      responseText: undefined,
      retryable: false,
      stage: "post",
    });
  }

  const sessionUrl = new URL(sessionLocation, resourceUrl);
  const expectedRemoteTrackCount = readExpectedRemoteTrackCount(response);
  const sdp = await readSdpResponse(response);
  return {
    expectedRemoteTrackCount,
    kind: response.status === 406 ? "counterOffer" : "accepted",
    sdp,
    sessionUrl,
  };
}

/**
 * 配信者 `resourceUserId` の再生リソースへ SDP オファーを POST する。
 *
 * @throws {WHEPSessionError} Worker がセッションを拒否したか、予期しない応答を返した場合。
 * 配信終了か配信者の再接続待ちかは `kind` で判別できる。
 * @throws {Error} リクエスト自体が失敗したか、`signal` で中断された場合。
 */
export async function postWhepOffer(
  resourceUserId: string,
  sdpOffer: string,
  signal: AbortSignal,
): Promise<WHEPOfferResponse> {
  const resourceUrl = new URL(
    `/play/${encodeURIComponent(resourceUserId)}`,
    window.location.origin,
  );
  const response = await fetch(resourceUrl, {
    method: "POST",
    headers: SDP_REQUEST_HEADERS,
    body: sdpOffer,
    signal,
  });
  return parseOfferResponse(response, resourceUrl);
}

/**
 * 406 のカウンターオファーへのアンサーを WHEP セッションへ PATCH する。
 *
 * @throws {WHEPSessionError} Worker がアンサーを 204 で受け入れなかった場合。
 * @throws {Error} リクエスト自体が失敗したか、`signal` で中断された場合。
 */
export async function patchWhepAnswer(
  sessionUrl: URL,
  sdpAnswer: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(sessionUrl, {
    method: "PATCH",
    headers: SDP_REQUEST_HEADERS,
    body: sdpAnswer,
    signal,
  });
  if (response.status !== 204) {
    throw await createResponseError(
      response,
      `Unexpected WHEP answer response: ${String(response.status)}`,
      "patch",
    );
  }
}
