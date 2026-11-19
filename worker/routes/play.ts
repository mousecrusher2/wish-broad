// WHEP 再生。公開された汎用 WHEP エンドポイントではなく、意図的にアプリ固有かつ
// Cookie 保護されたエンドポイントとしている。
import type { Context } from "hono";
import {
  LIVE_RECONNECTING_RETRY_AFTER_SECONDS,
  LIVE_TRACK_COUNT_HEADER,
} from "../../shared/protocol";
import {
  signPlaySession,
  verifyPlaySessionSignature,
} from "../lib/play-session-signature";
import { startPlayback, submitPlaybackAnswer } from "../live/playback";
import { appJwtAuth } from "../middleware/app-jwt";
import { createApp } from "./create-app";
import { readSdpBody } from "./sdp";

export const playRoutes = createApp();

/** 再生セッション URL のうち、セッションを作った視聴者への署名を載せるクエリパラメーター。 */
const SESSION_SIGNATURE_PARAM = "sig";

function createPlaySessionLocation(
  requestUrl: string,
  userId: string,
  sessionId: string,
  signature: string,
): string {
  const sessionUrl = new URL(
    `/play/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}`,
    requestUrl,
  );
  sessionUrl.searchParams.set(SESSION_SIGNATURE_PARAM, signature);
  return sessionUrl.toString();
}

/**
 * SFU のセッション ID として妥当な URL セーフ文字列か。WHEP セッションルートはデコード済みの
 * パスパラメーターを SFU API の URL に埋め込むため、"/" や "?" など URL を書き換えうる値を拒否する。
 */
function isSfuSessionId(sessionId: string): boolean {
  return /^[0-9A-Za-z_-]+$/u.test(sessionId);
}

/** 配信者の再接続待ちを示す 409。視聴者はこれを受けてリトライを続け、404 は配信終了を表す。 */
function respondLiveReconnecting(c: Context): Response {
  return c.text("Live stream is waiting for the publisher to reconnect", 409, {
    "Retry-After": String(LIVE_RECONNECTING_RETRY_AFTER_SECONDS),
  });
}

// 視聴は認証済みアプリユーザーのみに制限する。
playRoutes.use("/*", ...appJwtAuth("play.request"));

playRoutes.get("/:userId", async (c) => {
  return c.body(null, 204);
});

// WHEP 再生の開始。
playRoutes.post("/:userId", async (c) => {
  const { userId } = c.req.param();
  const viewerUserId = c.get("jwtPayload").userId;
  const sdpOffer = await readSdpBody(c, "offer");
  if (sdpOffer instanceof Response) {
    return sdpOffer;
  }

  const result = await startPlayback(
    c.env,
    c.executionCtx,
    userId,
    viewerUserId,
    sdpOffer,
  );
  switch (result.kind) {
    case "started": {
      const { session } = result;
      const signature = await signPlaySession(
        c.env.PLAY_SESSION_SIGNING_KEY,
        session.sessionId,
        viewerUserId,
      );
      return c.body(
        session.sdpAnswer,
        session.sdpType === "offer" ? 406 : 201,
        {
          "content-type": "application/sdp",
          [LIVE_TRACK_COUNT_HEADER]: String(result.expectedTrackCount),
          etag: `"${session.sessionId}"`,
          location: createPlaySessionLocation(
            c.req.url,
            userId,
            session.sessionId,
            signature,
          ),
        },
      );
    }
    case "not_found":
      return c.text(`Live stream not found: ${userId}`, 404);
    case "reconnecting":
      return respondLiveReconnecting(c);
    case "session_check_failed":
      return c.text("Failed to verify live stream status", 502);
    case "negotiation_rejected":
      return c.text(result.text, result.status);
    case "negotiation_failed":
      return c.text("Failed to negotiate playback session", 502);
  }
});

// WHEP 再生セッションへのカウンターオファーのアンサー送信。
playRoutes.get("/:userId/:sessionId", async () => {
  return new Response(null, { status: 204 });
});

playRoutes
  // 現在のフロントエンドは送らない。以前のフロントエンドが送る DELETE に成功を返すだけで、
  // SFU には何もしない（docs/architecture.md「再生のライフサイクル」）。
  .delete("/:userId/:sessionId", async (c) => {
    return c.body(null, 200);
  })
  // この PATCH はトリクル ICE ではなく、406 カウンターオファーへのアンサーを送信する。
  .patch(async (c) => {
    const { sessionId } = c.req.param();
    if (!isSfuSessionId(sessionId)) {
      return c.text("Invalid WHEP session ID", 400);
    }
    // このセッションを作った視聴者からの要求かを、Location に付けた署名で確かめる
    // （docs/architecture.md「再生のライフサイクル」）。
    const isSessionOwner = await verifyPlaySessionSignature(
      c.env.PLAY_SESSION_SIGNING_KEY,
      sessionId,
      c.get("jwtPayload").userId,
      c.req.query(SESSION_SIGNATURE_PARAM) ?? "",
    );
    if (!isSessionOwner) {
      return c.text("WHEP session not found", 404);
    }

    const sdpAnswer = await readSdpBody(c, "answer");
    if (sdpAnswer instanceof Response) {
      return sdpAnswer;
    }

    const result = await submitPlaybackAnswer(c.env, sessionId, sdpAnswer);
    switch (result.kind) {
      case "accepted":
        return c.body(null, 204);
      case "negotiation_rejected":
        return c.text(result.text, result.status);
      case "negotiation_failed":
        return c.text("Failed to submit WHEP answer", 502);
    }
  });
