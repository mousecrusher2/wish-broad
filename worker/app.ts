import type { Context } from "hono";
import { HonoBase } from "hono/hono-base";
import { LinearRouter } from "hono/router/linear-router";
import {
  LIVE_RECONNECT_GRACE_MS,
  LIVE_RECONNECTING_RETRY_AFTER_SECONDS,
  LIVE_TRACK_COUNT_HEADER,
} from "../shared/protocol";
import { JWTPayload, Bindings } from "./types";
import type { LiveRecord, StoredTrack } from "./live/types";
import {
  clearAuthCookie,
  completeDiscordLogin,
  startDiscordLogin,
} from "./routes/auth";
import {
  type IngestSession,
  type PlaybackSession,
  SfuApiError,
  closeTracks,
  renegotiateSession,
  startIngest,
  startPlay,
  LiveNotFoundError,
} from "./clients/sfu";
import { createLiveToken } from "./lib/live-token";
import { hashedBearerAuth } from "./middleware/hashed-bearer-auth";
import { HTTPException } from "hono/http-exception";
import { jwt } from "hono/jwt";
import { csrf } from "hono/csrf";
import { sendLiveStartedNotification } from "./clients/discord-webhook";
import { hashTokenWithPepper } from "./lib/token-hash";
import {
  generateTurnIceServers,
  TurnApiError,
  type TurnIceServer,
} from "./clients/turn";
import { createErrorLogFields, logError, logInfo, logWarn } from "./lib/logger";
import { getLiveState } from "./state/live-state";
import {
  checkLiveSession,
  type LiveSessionStatus,
  startLostSessionGrace,
} from "./live/session";

type AppEnv = {
  Bindings: Bindings;
  Variables: {
    jwtPayload: JWTPayload;
  };
};

const app = new HonoBase<AppEnv>({ router: new LinearRouter() });

function createPlaySessionLocation(
  requestUrl: string,
  userId: string,
  sessionId: string,
  tracks: StoredTrack[],
): string {
  const origin = new URL(requestUrl).origin;
  const sessionUrl = new URL(
    `/play/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}`,
    origin,
  );

  for (const track of tracks) {
    sessionUrl.searchParams.append("mid", track.mid);
  }

  return sessionUrl.toString();
}

function createSiteRootLocation(requestUrl: string): string {
  return new URL("/", requestUrl).toString();
}

function getRequestedTrackMids(requestUrl: string): string[] {
  const mids = new URL(requestUrl).searchParams.getAll("mid");
  const normalizedMids = mids.flatMap((mid) => {
    const trimmedMid = mid.trim();
    return trimmedMid ? [trimmedMid] : [];
  });
  return [...new Set(normalizedMids)];
}

/**
 * SFU のセッション ID として妥当な URL セーフ文字列か。WHEP セッションルートはデコード済みの
 * パスパラメーターを SFU API の URL に埋め込むため、"/" や "?" など URL を書き換えうる値を拒否する。
 */
function isSfuSessionId(sessionId: string): boolean {
  return /^[0-9A-Za-z_-]+$/u.test(sessionId);
}

function createWhepCloseTracks(
  sessionId: string,
  mids: string[],
): StoredTrack[] {
  return mids.map((mid) => ({
    location: "remote",
    mid,
    sessionId,
    trackName: mid,
  }));
}

/**
 * トラックを waitUntil 内で閉じる。クリーンアップにすぎないため、失敗はログ出力だけで済ませる
 * （配信行はすでに更新済みで、無効なトラックロケーターが公開され続けることはない）。
 */
function scheduleTrackClose(
  c: Context<AppEnv>,
  sessionId: string,
  tracks: StoredTrack[],
  failureLabel: string,
  errorLabel: string,
): void {
  c.executionCtx.waitUntil(
    closeTracks(c.env, sessionId, tracks).then(
      (response) => {
        if (
          response.errorCode ||
          response.tracks?.some((track) => track.errorCode)
        ) {
          logWarn(c.env, "track_close.sfu_errors", {
            message: errorLabel,
            response,
            sessionId,
          });
        }
      },
      (error: unknown) => {
        if (
          error instanceof SfuApiError &&
          (error.kind === "session_not_found" || error.kind === "session_gone")
        ) {
          return;
        }
        logWarn(c.env, "track_close.failed", {
          ...createErrorLogFields(error),
          message: failureLabel,
          sessionId,
        });
      },
    ),
  );
}

/**
 * 開始通知を送信し、そのメッセージ ID を LiveState に保存する。配信がすでに終了していた
 * 場合は LiveState が削除を Worker に引き渡す。インジェスト応答の返却後に waitUntil 内で
 * 実行されるため、失敗はすべてスローせずログ出力する。
 */
async function sendLiveStartNotification(
  c: Context<AppEnv>,
  userId: string,
  broadcastId: string,
  sessionId: string,
  siteUrl: string,
): Promise<void> {
  let messageId: bigint;
  try {
    ({ messageId } = await sendLiveStartedNotification(c.env, userId, siteUrl));
  } catch (error: unknown) {
    logWarn(c.env, "live_notification.send_failed", {
      ...createErrorLogFields(error),
      sessionId,
      userId,
    });
    return;
  }

  try {
    await getLiveState(c.env).setLiveNotificationMessageId(
      userId,
      broadcastId,
      messageId.toString(),
    );
  } catch (error: unknown) {
    logWarn(c.env, "live_notification.persist_failed", {
      ...createErrorLogFields(error),
      messageId: messageId.toString(),
      sessionId,
      userId,
    });
  }
}

/** 配信者の再接続待ちを示す 409。視聴者はこれを受けてリトライを続け、404 は配信終了を表す。 */
function respondLiveReconnecting(c: Context<AppEnv>): Response {
  return c.text("Live stream is waiting for the publisher to reconnect", 409, {
    "Retry-After": String(LIVE_RECONNECTING_RETRY_AFTER_SECONDS),
  });
}

function isSdpContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  return contentType.split(";")[0]?.trim().toLowerCase() === "application/sdp";
}

function toErrorResponse(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  return c.text("Internal Server Error", 500);
}

app.onError((err, c) => {
  if (!(err instanceof HTTPException)) {
    logError(c.env, "worker.unhandled_error", createErrorLogFields(err));
  }

  return toErrorResponse(err, c);
});

// OBS インジェストの認証には視聴者用 JWT ではなく、ユーザーごとの配信トークンを使用する。
app.use(
  "/ingest/:userId",
  hashedBearerAuth<AppEnv, "/ingest/:userId">({
    pepper: (c) => c.env.LIVE_TOKEN_PEPPER,
    token: (c) => {
      const { userId } = c.req.param();
      return getLiveState(c.env).getLiveTokenHash(userId);
    },
  }),
);
app.use(
  "/ingest/:userId/:sessionId",
  hashedBearerAuth<AppEnv, "/ingest/:userId/:sessionId">({
    pepper: (c) => c.env.LIVE_TOKEN_PEPPER,
    token: (c) => {
      const { userId } = c.req.param();
      return getLiveState(c.env).getLiveTokenHash(userId);
    },
  }),
);
app.use("/ingest/:userId", async (c, next) => {
  const { userId } = c.req.param();
  logInfo(c.env, "ingest.request", { userId });
  await next();
});
app.use("/ingest/:userId/:sessionId", async (c, next) => {
  const { sessionId, userId } = c.req.param();
  logInfo(c.env, "ingest.request", { sessionId, userId });
  await next();
});

app.get("/ingest/:userId", async (c) => {
  return c.body(null, 204);
});

// WHIP インジェストの開始。新しいインジェストは OBS の再接続待ち中の既存配信を
// 再開するか、開始通知を伴って新しい配信を開始する。
app.post("/ingest/:userId", async (c) => {
  const { userId } = c.req.param();
  if (!isSdpContentType(c.req.header("content-type"))) {
    return c.text("Content-Type must be application/sdp", 415);
  }

  const sdpOffer = await c.req.text();
  if (!sdpOffer || sdpOffer.trim().length === 0) {
    return c.text("SDP offer is required", 400);
  }

  const liveState = getLiveState(c.env);
  let resumableLive: LiveRecord | null = null;
  const existingLive = await liveState.getLive(userId);
  if (existingLive) {
    let sessionStatus: LiveSessionStatus;
    try {
      sessionStatus = await checkLiveSession(
        c.env,
        c.executionCtx,
        existingLive,
      );
    } catch (error: unknown) {
      if (!(error instanceof SfuApiError)) {
        throw error;
      }
      logError(c.env, "ingest.session_activity_check_failed", {
        ...createErrorLogFields(error),
        sessionId: existingLive.sessionId,
        userId,
      });
      return c.text("Failed to verify ingest session status", 502);
    }

    switch (sessionStatus) {
      case "active":
        return c.text("A live stream is already active for this user", 400);
      case "reconnect_grace":
      case "recently_lost":
        // OBS の再接続とみなし、通知せずに配信を再開する。
        resumableLive = existingLive;
        break;
      case "lost":
        // ずっと前に失われたセッションかもしれないため、新しい配信として開始して通知する。
        // その間に行が更新されていた場合は、後続の insertLive がこのインジェストを拒否する。
        await liveState.endLive(userId, existingLive.sessionId);
        break;
    }
  }

  let result: IngestSession;
  try {
    result = await startIngest(c.env, userId, sdpOffer);
  } catch (error: unknown) {
    if (!(error instanceof SfuApiError)) {
      throw error;
    }
    const negotiationError = error.toNegotiationClientError(
      "Failed to negotiate ingest session",
    );
    if (negotiationError) {
      return c.text(negotiationError.text, negotiationError.status);
    }

    logError(c.env, "ingest.negotiation_failed", {
      ...createErrorLogFields(error),
      userId,
    });
    return c.text("Internal Server Error", 500);
  }

  const respondWithAnswer = () =>
    c.body(result.sdpAnswer, 201, {
      "content-type": "application/sdp",
      etag: `"${result.sessionId}"`,
      location: `/ingest/${userId}/${result.sessionId}`,
    });

  if (
    resumableLive &&
    (await liveState.resumeLive(
      userId,
      resumableLive.sessionId,
      result.sessionId,
      result.tracks,
    ))
  ) {
    logInfo(c.env, "ingest.resumed", {
      previousSessionId: resumableLive.sessionId,
      reason:
        resumableLive.graceExpiresAt === null
          ? "session_lost"
          : "reconnect_grace",
      sessionId: result.sessionId,
      userId,
    });
    return respondWithAnswer();
  }

  // 再開対象がそもそも存在しなかったか、セッションのネゴシエーション中に配信が
  // 終了したため、新しい配信を開始する。
  const broadcastId = await liveState.insertLive(
    userId,
    result.sessionId,
    result.tracks,
  );
  if (broadcastId === null) {
    // 行を読み取った後で、競合する別のインジェストが先に行を作成または再開した。
    // このインジェストの SFU セッションは誰も使わず、SFU が自動で片付ける。
    logWarn(c.env, "ingest.concurrent_ingest_rejected", {
      sessionId: result.sessionId,
      userId,
    });
    return c.text("A live stream is already active for this user", 400);
  }

  const notifyParam = c.req.query("notify");
  if (notifyParam !== "false" && notifyParam !== "0") {
    c.executionCtx.waitUntil(
      sendLiveStartNotification(
        c,
        userId,
        broadcastId,
        result.sessionId,
        createSiteRootLocation(c.req.url),
      ),
    );
  }

  return respondWithAnswer();
});

app.get("/ingest/:userId/:sessionId", async () => {
  return new Response(null, { status: 204 });
});

// WHIP インジェストの終了。現在保存されているセッションのみがそのインジェストを終了できる。
app.delete("/ingest/:userId/:sessionId", async (c) => {
  const { userId, sessionId } = c.req.param();

  const liveState = getLiveState(c.env);
  const existingLive = await liveState.getLive(userId);
  if (!existingLive) {
    return c.text("No live stream found for this user", 400);
  }

  if (existingLive.sessionId !== sessionId) {
    return c.text("Session ID does not match the active live stream", 400);
  }

  if (existingLive.graceExpiresAt !== null) {
    // すでに終了済みのインジェストに対する重複 DELETE。
    return c.text("OK", 200);
  }

  if (
    existingLive.tracks.length === 0 ||
    existingLive.tracks.some((track) => track.mid.length === 0)
  ) {
    return c.text("Stored live track data is invalid", 500);
  }

  // DELETE は再接続と区別できないため、配信は終了させず再接続猶予を始める
  // （docs/architecture.md「インジェストのライフサイクル」）。
  const graceExpiresAt = await liveState.startLiveReconnectGrace(
    userId,
    sessionId,
    LIVE_RECONNECT_GRACE_MS,
  );
  if (graceExpiresAt === null) {
    return c.text("Failed to delete the requested live stream", 400);
  }

  // このインジェストセッションが終了したため、保存済みトラックロケーターは無効になる。
  scheduleTrackClose(
    c,
    sessionId,
    existingLive.tracks,
    `Failed to close live tracks for user ${userId}:`,
    `SFU reported track close errors for user ${userId}:`,
  );

  return c.text("OK", 200);
});

app.get("/login", (c) => {
  return startDiscordLogin(c);
});

app.get("/login/callback", async (c) => {
  return completeDiscordLogin(c);
});

app.post("/logout", csrf(), async (c) => {
  clearAuthCookie(c);
  return c.redirect("/");
});

// 視聴は認証済みアプリユーザーのみに制限する。
app.use("/play/*", csrf());
app.use("/play/*", async (c, next) => {
  const middleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  });
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Hono の jwt ミドルウェアが具象的なアプリコンテキスト型を消去するため。
  return middleware(c, next);
});
app.use("/play/*", async (c, next) => {
  const jwtPayload = c.get("jwtPayload");
  logInfo(c.env, "play.request", { userId: jwtPayload.userId });
  await next();
});

app.get("/play/:userId", async (c) => {
  return c.body(null, 204);
});

// WHEP 再生の開始。公開された汎用 WHEP エンドポイントではなく、意図的にアプリ固有かつ
// Cookie 保護されたエンドポイントとしている。
app.post("/play/:userId", async (c) => {
  const { userId } = c.req.param();

  const jwtPayload = c.get("jwtPayload");

  const liveState = getLiveState(c.env);
  const liveTrackRecord = await liveState.getLive(userId);
  const tracks = liveTrackRecord?.tracks ?? [];
  if (liveTrackRecord) {
    let sessionStatus: LiveSessionStatus;
    try {
      sessionStatus = await checkLiveSession(
        c.env,
        c.executionCtx,
        liveTrackRecord,
      );
    } catch (error: unknown) {
      if (!(error instanceof SfuApiError)) {
        throw error;
      }
      logError(c.env, "play.session_activity_check_failed", {
        ...createErrorLogFields(error),
        sessionId: liveTrackRecord.sessionId,
        userId,
      });
      return c.text("Failed to verify live stream status", 502);
    }

    switch (sessionStatus) {
      case "active":
        break;
      case "reconnect_grace":
        // 保存済みトラックは DELETE 時に閉じられているため、再開か配信終了まで視聴者にリトライさせる。
        return respondLiveReconnecting(c);
      case "recently_lost":
        await startLostSessionGrace(c.env, liveTrackRecord);
        return respondLiveReconnecting(c);
      case "lost":
        // その間に行が更新されていた場合（OBS が DELETE を送信または再開済み）、
        // 終了を報告するのではなく新しい状態に対して視聴者にリトライさせる。
        return (await liveState.endLive(userId, liveTrackRecord.sessionId))
          ? c.text(`Live stream not found: ${userId}`, 404)
          : respondLiveReconnecting(c);
    }
  }

  if (!isSdpContentType(c.req.header("content-type"))) {
    return c.text("Content-Type must be application/sdp", 415);
  }

  const sdpOffer = await c.req.text();
  if (!sdpOffer || sdpOffer.trim().length === 0) {
    return c.text("SDP offer is required", 400);
  }

  let result: PlaybackSession;
  try {
    result = await startPlay(c.env, userId, tracks, sdpOffer);
  } catch (error: unknown) {
    if (error instanceof LiveNotFoundError) {
      return c.text(`Live stream not found: ${userId}`, 404);
    }
    if (!(error instanceof SfuApiError)) {
      throw error;
    }
    if (error.isSessionNotFound()) {
      if (liveTrackRecord) {
        // 上で確認した時点ではインジェストセッションは生存していたため、
        // SFU がたった今ガベージコレクションしたとみなせる。
        await startLostSessionGrace(c.env, liveTrackRecord);
        return respondLiveReconnecting(c);
      }
      return c.text(`Live stream not found: ${userId}`, 404);
    }
    logError(c.env, "play.negotiation_failed", {
      ...createErrorLogFields(error),
      userId,
      viewerUserId: jwtPayload.userId,
    });
    const negotiationError = error.toNegotiationClientError(
      "Failed to negotiate playback session",
    );
    if (negotiationError) {
      return c.text(negotiationError.text, negotiationError.status);
    }

    return c.text("Failed to negotiate playback session", 502);
  }

  const status = result.sdpType === "offer" ? 406 : 201;
  // ネゴシエート済みの数ではなく保存済みの数を返し、一部のトラックしか得られなかった
  // 再生をクライアントに作り直させる。
  const expectedTrackCount = tracks.length;

  return c.body(result.sdpAnswer, status, {
    "content-type": "application/sdp",
    [LIVE_TRACK_COUNT_HEADER]: String(expectedTrackCount),
    etag: `"${result.sessionId}"`,
    location: createPlaySessionLocation(
      c.req.url,
      userId,
      result.sessionId,
      result.tracks,
    ),
  });
});

// WHEP 再生セッションのクリーンアップおよびカウンターオファーへのアンサー送信。
app.get("/play/:userId/:sessionId", async () => {
  return new Response(null, { status: 204 });
});

app
  .delete("/play/:userId/:sessionId", async (c) => {
    const { sessionId } = c.req.param();
    if (!isSfuSessionId(sessionId)) {
      return c.text("Invalid WHEP session ID", 400);
    }
    const mids = getRequestedTrackMids(c.req.url);
    if (mids.length === 0) {
      return c.text("WHEP session track mids are required", 400);
    }

    scheduleTrackClose(
      c,
      sessionId,
      createWhepCloseTracks(sessionId, mids),
      `Failed to close WHEP session ${sessionId}:`,
      `SFU reported WHEP session close errors for session ${sessionId}:`,
    );

    return c.body(null, 200);
  })
  // この PATCH はトリクル ICE ではなく、406 カウンターオファーへのアンサーを送信する。
  .patch(async (c) => {
    const { sessionId } = c.req.param();
    if (!isSfuSessionId(sessionId)) {
      return c.text("Invalid WHEP session ID", 400);
    }

    if (!isSdpContentType(c.req.header("content-type"))) {
      return c.text("Content-Type must be application/sdp", 415);
    }

    const sdpAnswer = await c.req.text();
    if (!sdpAnswer || sdpAnswer.trim().length === 0) {
      return c.text("SDP answer is required", 400);
    }

    try {
      await renegotiateSession(c.env, sessionId, sdpAnswer);
    } catch (error: unknown) {
      if (!(error instanceof SfuApiError)) {
        throw error;
      }
      const negotiationError = error.toNegotiationClientError(
        "Failed to submit WHEP answer",
      );
      if (negotiationError) {
        return c.text(negotiationError.text, negotiationError.status);
      }

      logError(c.env, "play.answer_submission_failed", {
        ...createErrorLogFields(error),
        sessionId,
      });
      return c.text("Failed to submit WHEP answer", 502);
    }

    return c.body(null, 204);
  });

// すべての /api ルートはアプリの JWT Cookie を必要とするブラウザ向け API である。
app.use("/api/*", csrf());
app.use("/api/*", async (c, next) => {
  const middleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  });
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Hono の jwt ミドルウェアが具象的なアプリコンテキスト型を消去するため。
  return middleware(c, next);
});
app.use("/api/*", async (c, next) => {
  const jwtPayload = c.get("jwtPayload");
  logInfo(c.env, "api.request", { userId: jwtPayload.userId });
  await next();
});

app.get("/api/me", async (c) => {
  const jwtPayload = c.get("jwtPayload");

  return c.json({
    userId: jwtPayload.userId,
    displayName: jwtPayload.displayName,
  });
});

app.get("/api/turn-credentials", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  let iceServers: TurnIceServer[];
  try {
    iceServers = await generateTurnIceServers(c.env, jwtPayload.userId);
  } catch (error: unknown) {
    if (!(error instanceof TurnApiError)) {
      throw error;
    }
    logError(c.env, "turn_credentials.generate_failed", {
      ...createErrorLogFields(error),
      userId: jwtPayload.userId,
    });
    return c.text(
      "Failed to generate TURN credentials",
      error.kind === "request_timeout" ? 504 : 502,
    );
  }

  c.header("Cache-Control", "no-store");
  return c.json({ iceServers });
});

// 配信トークンはいつでもローテーションできる。生のトークンは作成時にのみ返し、
// ストレージにはペッパー付き HMAC のみを保存する。
app.post("/api/me/livetoken", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  const userId = jwtPayload.userId;
  const token = createLiveToken();
  const tokenHash = await hashTokenWithPepper(c.env.LIVE_TOKEN_PEPPER, token);

  try {
    await getLiveState(c.env).setLiveToken(userId, tokenHash);
  } catch (error: unknown) {
    logError(c.env, "live_token.save_failed", {
      ...createErrorLogFields(error),
      userId,
    });
    return c.text("Failed to save live token", 500);
  }

  return c.json({
    success: true,
    token,
  });
});

// 副作用のないトークン状態確認。既存のトークン値は決して返さない。
app.get("/api/me/livetoken", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  const userId = jwtPayload.userId;
  let hasToken: boolean;
  try {
    hasToken = await getLiveState(c.env).hasLiveToken(userId);
  } catch (error: unknown) {
    logError(c.env, "live_token.status_check_failed", {
      ...createErrorLogFields(error),
      userId,
    });
    return c.text("Failed to check live token", 500);
  }

  return c.json({ hasToken });
});

app.get("/api/lives", async (c) => {
  // 一覧を軽量に保つため SFU には問い合わせない。古い行はインジェストや再生のときに整合をとる
  // （docs/architecture.md「配信行のセマンティクス」）。
  const lives = await getLiveState(c.env).getAllLives();
  return c.json(lives);
});

export default app;
