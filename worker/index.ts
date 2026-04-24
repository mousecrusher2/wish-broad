/* eslint-disable sonarjs/cognitive-complexity */
import { Context, Hono } from "hono";
import { JWTPayload, Bindings } from "./types";
import * as db from "./database";
import {
  clearAuthCookie,
  completeDiscordLogin,
  startDiscordLogin,
} from "./discord-login";
import {
  SfuApiError,
  type StoredTrack,
  closeTracks,
  isSessionActive,
  renegotiateSession,
  startIngest,
  startPlay,
  LiveNotFoundError,
} from "./sfu";
import { createLiveToken } from "./live-token";
import { hashedBearerAuth } from "./hashed-bearer-auth";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { jwt } from "hono/jwt";
import { deleteLiveStartedNotification, sendLiveStartedNotification } from "./notifications";
import { hashTokenWithPepper } from "./token-hash";
import { generateTurnIceServers } from "./turn";

type AppEnv = {
  Bindings: Bindings;
  Variables: {
    jwtPayload: JWTPayload;
  };
};

const app = new Hono<AppEnv>();

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
  return [...new Set(mids.map((mid) => mid.trim()).filter(Boolean))];
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

function scheduleTrackClose(
  c: Context<AppEnv>,
  sessionId: string,
  tracks: StoredTrack[],
  failureLabel: string,
  errorLabel: string,
): void {
  c.executionCtx.waitUntil(
    closeTracks(c.env, sessionId, tracks).then((closeResult) => {
      if (closeResult.isErr()) {
        if (
          closeResult.error.kind !== "session_not_found" &&
          closeResult.error.kind !== "session_gone"
        ) {
          console.warn(failureLabel, closeResult.error);
        }
        return;
      }

      if (
        closeResult.value.errorCode ||
        closeResult.value.tracks?.some((track) => track.errorCode)
      ) {
        console.warn(errorLabel, closeResult.value);
      }
    }),
  );
}

async function sendLiveStartNotification(
  c: Context<AppEnv>,
  userId: string,
  sessionId: string,
  siteUrl: string,
): Promise<void> {
  const notificationResult = await sendLiveStartedNotification(
    c.env,
    userId,
    siteUrl,
  );
  if (notificationResult.isErr()) {
    console.warn(
      `Failed to send live start notification for user ${userId} session ${sessionId}:`,
      notificationResult.error,
    );
    return;
  }

  const { messageId } = notificationResult.value;

  type PersistNotificationResult =
    | { ok: true; saved: boolean }
    | { ok: false; error: Error };
  const persistResult: PersistNotificationResult = await db
    .setLiveNotificationMessageId(c.env.LIVE_DB, userId, sessionId, messageId)
    .then((saved): PersistNotificationResult => ({ ok: true, saved }))
    .catch(
      (error: Error): PersistNotificationResult => ({ ok: false, error }),
    );

  if (!persistResult.ok) {
    console.warn(
      `Failed to persist live start notification id for user ${userId} session ${sessionId}:`,
      persistResult.error,
    );
  }

  if (persistResult.ok && persistResult.saved) {
    return;
  }

  const deleteResult = await deleteLiveStartedNotification(c.env, messageId);
  if (deleteResult.isErr()) {
    console.warn(
      `Failed to delete orphaned live start notification for user ${userId} session ${sessionId}:`,
      deleteResult.error,
    );
  }
}

function isSdpContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  return contentType.split(";")[0]?.trim().toLowerCase() === "application/sdp";
}

function logUnexpectedError(error: Error): void {
  console.error("Unhandled error:", error, error.stack);
}

function toErrorResponse(
  err: unknown,
  c: Context<AppEnv>,
): Response {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  return c.text("Internal Server Error", 500);
}

app.onError((err, c) => {
  if (!(err instanceof HTTPException)) {
    logUnexpectedError(err);
  }

  return toErrorResponse(err, c);
});

app.use(logger());

// 配信取り込み用エンドポイントの認証ミドルウェア
app.use(
  "/ingest/:userId/*",
  hashedBearerAuth<AppEnv, "/ingest/:userId/*">({
    pepper: (c) => c.env.LIVE_TOKEN_PEPPER,
    token: (c) => {
      const { userId } = c.req.param();
      return db.getLiveTokenHash(c.env.LIVE_DB, userId);
    },
  }),
);

app.get("/ingest/:userId", async (c) => {
  return c.body(null, 204);
});

// ライブ配信開始エンドポイント（WHIP）
// 配信者からのSDP Offerを受け取り、Cloudflareセッションを作成
app.post("/ingest/:userId", async (c) => {
  const { userId } = c.req.param();
  if (!isSdpContentType(c.req.header("content-type"))) {
    return c.text("Content-Type must be application/sdp", 415);
  }

  const sdpOffer = await c.req.text();
  if (!sdpOffer || sdpOffer.trim().length === 0) {
    return c.text("SDP offer is required", 400);
  }

  const existingLive = await db.getLive(c.env.LIVE_DB, userId);
  if (existingLive) {
    const isActiveResult = await isSessionActive(c.env, existingLive.sessionId);
    if (isActiveResult.isErr()) {
      console.error(
        `Failed to verify ingest session activity for user ${userId}:`,
        isActiveResult.error,
      );
      return c.text("Failed to verify ingest session status", 502);
    }

    if (isActiveResult.value) {
      return c.text("A live stream is already active for this user", 400);
    }

    const deleted = await db.deleteLiveForSession(
      c.env.LIVE_DB,
      userId,
      existingLive.sessionId,
    );
    if (deleted) {
      const notificationMessageId = existingLive.notificationMessageId;
      if (notificationMessageId !== null && notificationMessageId !== undefined) {
        c.executionCtx.waitUntil(
          deleteLiveStartedNotification(c.env, notificationMessageId).then(
            (deleteResult) => {
              if (deleteResult.isErr()) {
                console.warn(
                  `Failed to delete live start notification for user ${userId} session ${existingLive.sessionId}:`,
                  deleteResult.error,
                );
              }
            },
          ),
        );
      }
    }
  }

  const ingestResult = await startIngest(c.env, userId, sdpOffer);
  if (ingestResult.isErr()) {
    const negotiationError = ingestResult.error.toNegotiationClientError(
      "Failed to negotiate ingest session",
    );
    if (negotiationError) {
      return c.text(negotiationError.text, negotiationError.status);
    }

    console.error(
      `Failed to negotiate ingest session for user ${userId}:`,
      ingestResult.error,
    );
    return c.text("Internal Server Error", 500);
  }

  const result = ingestResult.value;
  // トラック情報をデータベースに保存（session_idも含める）
  await db.insertLive(c.env.LIVE_DB, userId, result.sessionId, result.tracks);

  c.executionCtx.waitUntil(
    sendLiveStartNotification(
      c,
      userId,
      result.sessionId,
      createSiteRootLocation(c.req.url),
    ),
  );

  return c.body(result.sdpAnswer, 201, {
    "content-type": "application/sdp",
    etag: `"${result.sessionId}"`,
    location: `/ingest/${userId}/${result.sessionId}`,
  });
});

// ライブ配信終了エンドポイント
// 配信セッションを削除し、関連データを清理
app.get("/ingest/:userId/:sessionId", async () => {
  return new Response(null, { status: 204 });
});

app.delete("/ingest/:userId/:sessionId", async (c) => {
  const { userId, sessionId } = c.req.param();

  const existingLive = await db.getLive(c.env.LIVE_DB, userId);
  if (!existingLive) {
    return c.text("No live stream found for this user", 400);
  }

  if (existingLive.sessionId !== sessionId) {
    return c.text("Session ID does not match the active live stream", 400);
  }

  if (
    existingLive.tracks.length === 0 ||
    existingLive.tracks.some((track) => track.mid.length === 0)
  ) {
    return c.text("Stored live track data is invalid", 500);
  }

  const deleted = await db.deleteLiveForSession(
    c.env.LIVE_DB,
    userId,
    sessionId,
  );
  if (!deleted) {
    return c.text("Failed to delete the requested live stream", 400);
  }

  scheduleTrackClose(
    c,
    sessionId,
    existingLive.tracks,
    `Failed to close live tracks for user ${userId}:`,
    `SFU reported track close errors for user ${userId}:`,
  );
  if (
    existingLive.notificationMessageId !== null &&
    existingLive.notificationMessageId !== undefined
  ) {
    c.executionCtx.waitUntil(
      deleteLiveStartedNotification(c.env, existingLive.notificationMessageId).then(
        (deleteResult) => {
          if (deleteResult.isErr()) {
            console.warn(
              `Failed to delete live start notification for user ${userId} session ${sessionId}:`,
              deleteResult.error,
            );
          }
        },
      ),
    );
  }

  return c.text("OK", 200);
});

// Discord認証開始エンドポイント
app.get("/login", (c) => {
  return startDiscordLogin(c);
});

// Discord認証完了エンドポイント
// Discord OAuth code flowを完了し、ギルドメンバーシップを確認後JWTトークンを発行
app.get("/login/callback", async (c) => {
  return completeDiscordLogin(c);
});

app.post("/logout", async (c) => {
  clearAuthCookie(c);
  return c.redirect("/");
});

// ライブ視聴用エンドポイントの認証ミドルウェア
app.use("/play/*", async (c, next) => {
  const middleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return middleware(c, next);
});

// ライブ視聴開始エンドポイント（WHEP）
// 視聴者からのSDP Offerを受け取り、配信されているトラックへの接続セッションを作成
app.get("/play/:userId", async (c) => {
  return c.body(null, 204);
});

app.post("/play/:userId", async (c) => {
  const { userId } = c.req.param();

  // JWTペイロードからユーザー情報を取得してログ出力
  const jwtPayload = c.get("jwtPayload");
  console.log(
    `User ${jwtPayload.displayName} (${jwtPayload.userId}) is trying to play user: ${userId}`,
  );

  // SFU APIクライアントを初期化
  const liveTrackRecord = await db.getLive(c.env.LIVE_DB, userId);
  const tracks = liveTrackRecord?.tracks ?? [];
  let hasActiveSession = false;
  if (liveTrackRecord) {
    const isActiveResult = await isSessionActive(c.env, liveTrackRecord.sessionId);
    if (isActiveResult.isErr()) {
      console.error(
        `Failed to verify playback session activity for user ${userId}:`,
        isActiveResult.error,
      );
      return c.text("Failed to verify live stream status", 502);
    }
    hasActiveSession = isActiveResult.value;
  }

  if (liveTrackRecord && !hasActiveSession) {
    const deleted = await db.deleteLiveForSession(
      c.env.LIVE_DB,
      userId,
      liveTrackRecord.sessionId,
    );
    if (deleted) {
      const notificationMessageId = liveTrackRecord.notificationMessageId;
      if (notificationMessageId !== null && notificationMessageId !== undefined) {
        c.executionCtx.waitUntil(
          deleteLiveStartedNotification(c.env, notificationMessageId).then(
            (deleteResult) => {
              if (deleteResult.isErr()) {
                console.warn(
                  `Failed to delete live start notification for user ${userId} session ${liveTrackRecord.sessionId}:`,
                  deleteResult.error,
                );
              }
            },
          ),
        );
      }
    }
    return c.text(`Live stream not found: ${userId}`, 404);
  }

  if (!isSdpContentType(c.req.header("content-type"))) {
    return c.text("Content-Type must be application/sdp", 415);
  }

  const sdpOffer = await c.req.text();
  if (!sdpOffer || sdpOffer.trim().length === 0) {
    return c.text("SDP offer is required", 400);
  }

  const playResult = await startPlay(c.env, userId, tracks, sdpOffer);
  if (playResult.isErr()) {
    const error = playResult.error;
    if (error instanceof LiveNotFoundError) {
      return c.text(`Live stream not found: ${userId}`, 404);
    }
    if (error instanceof SfuApiError && error.isSessionNotFound()) {
      if (liveTrackRecord) {
        const deleted = await db.deleteLiveForSession(
          c.env.LIVE_DB,
          userId,
          liveTrackRecord.sessionId,
        );
        if (deleted) {
          const notificationMessageId = liveTrackRecord.notificationMessageId;
          if (notificationMessageId !== null && notificationMessageId !== undefined) {
            c.executionCtx.waitUntil(
              deleteLiveStartedNotification(c.env, notificationMessageId).then(
                (deleteResult) => {
                  if (deleteResult.isErr()) {
                    console.warn(
                      `Failed to delete live start notification for user ${userId} session ${liveTrackRecord.sessionId}:`,
                      deleteResult.error,
                    );
                  }
                },
              ),
            );
          }
        }
      }
      return c.text(`Live stream not found: ${userId}`, 404);
    }
    console.error(
      `Failed to start play for user ${userId} by user ${jwtPayload.userId}:`,
      error,
    );
    if (error instanceof SfuApiError) {
      const negotiationError = error.toNegotiationClientError(
        "Failed to negotiate playback session",
      );
      if (negotiationError) {
        return c.text(negotiationError.text, negotiationError.status);
      }
    }

    return c.text("Failed to negotiate playback session", 502);
  }

  const result = playResult.value;
  const status = result.sdpType === "offer" ? 406 : 201;
  // Use the stored live track count, not the negotiated playback track count.
  // If playback only negotiates a subset, treat it as incomplete and let the
  // client reconnect instead of accepting the degraded session as healthy.
  const expectedTrackCount = tracks.length;

  return c.body(result.sdpAnswer, status, {
    "content-type": "application/sdp",
    "Wish-Live-Track-Count": String(expectedTrackCount),
    etag: `"${result.sessionId}"`,
    location: createPlaySessionLocation(
      c.req.url,
      userId,
      result.sessionId,
      result.tracks,
    ),
  });
});

// ライブ視聴セッション管理エンドポイント
app.get("/play/:userId/:sessionId", async () => {
  return new Response(null, { status: 204 });
});

app
  .delete("/play/:userId/:sessionId", async (c) => {
    const { sessionId } = c.req.param();
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
  }) // ICE候補やセッション再交渉用のPATCHエンドポイント
  .patch(async (c) => {
    const { sessionId } = c.req.param();

    if (!isSdpContentType(c.req.header("content-type"))) {
      return c.text("Content-Type must be application/sdp", 415);
    }

    const sdpAnswer = await c.req.text();
    if (!sdpAnswer || sdpAnswer.trim().length === 0) {
      return c.text("SDP answer is required", 400);
    }

    const renegotiationResult = await renegotiateSession(c.env, sessionId, sdpAnswer);
    if (renegotiationResult.isErr()) {
      const negotiationError = renegotiationResult.error.toNegotiationClientError(
        "Failed to submit WHEP answer",
      );
      if (negotiationError) {
        return c.text(negotiationError.text, negotiationError.status);
      }

      console.error(
        `Failed to submit WHEP answer for session ${sessionId}:`,
        renegotiationResult.error,
      );
      return c.text("Failed to submit WHEP answer", 502);
    }

    return c.body(null, 204);
  });

// API routes用の認証ミドルウェア
app.use("/api/*", async (c, next) => {
  const middleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return middleware(c, next);
});

// ユーザー情報を取得するAPIエンドポイント
// JWTトークンからユーザー情報を抽出して返す
app.get("/api/me", async (c) => {
  const jwtPayload = c.get("jwtPayload");

  return c.json({
    userId: jwtPayload.userId,
    displayName: jwtPayload.displayName,
  });
});

app.get("/api/turn-credentials", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  const turnResult = await generateTurnIceServers(c.env, jwtPayload.userId);
  if (turnResult.isErr()) {
    console.error(
      `Failed to generate TURN credentials for viewer ${jwtPayload.userId}:`,
      turnResult.error,
    );
    return c.text(
      "Failed to generate TURN credentials",
      turnResult.error.kind === "request_timeout" ? 504 : 502,
    );
  }

  c.header("Cache-Control", "no-store");
  return c.json({
    iceServers: turnResult.value,
  });
});

// 配信用トークンを発行するAPIエンドポイント
// 何度でも発行可能で、新しいトークンで上書きされる
// トークンは作成時にのみ表示される
app.post("/api/me/livetoken", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  const userId = jwtPayload.userId;
  const token = createLiveToken();
  const tokenHash = await hashTokenWithPepper(c.env.LIVE_TOKEN_PEPPER, token);

  type SaveTokenResult = { ok: true } | { ok: false; error: Error };
  const saveResult: SaveTokenResult = await db.setLiveToken(
    c.env.LIVE_DB,
    userId,
    tokenHash,
  )
    .then((): SaveTokenResult => ({ ok: true }))
    .catch((error: Error): SaveTokenResult => ({ ok: false, error }));
  if (!saveResult.ok) {
    console.error("Failed to save live token:", saveResult.error);
    return c.text("Failed to save live token", 500);
  }

  return c.json({
    success: true,
    token,
  });
});

// 配信用トークンの発行状況を確認するAPIエンドポイント
// 副作用なし：トークンは表示せず、発行状況のみを返す
app.get("/api/me/livetoken", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  const userId = jwtPayload.userId;
  type HasTokenResult =
    | { ok: true; hasToken: boolean }
    | { ok: false; error: Error };
  const hasTokenResult: HasTokenResult = await db.hasLiveToken(c.env.LIVE_DB, userId)
    .then((hasToken): HasTokenResult => ({ ok: true, hasToken }))
    .catch((error: Error): HasTokenResult => ({ ok: false, error }));
  if (!hasTokenResult.ok) {
    console.error(
      `Failed to check live token for user ${userId}:`,
      hasTokenResult.error,
    );
    return c.text("Failed to check live token", 500);
  }

  return c.json({
    hasToken: hasTokenResult.hasToken,
  });
});

app.get("/api/lives", async (c) => {
  const lives = await db.getAllLives(c.env.LIVE_DB);
  return c.json(lives);
});

export default app;
