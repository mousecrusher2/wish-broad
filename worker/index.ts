import { Context, Hono } from "hono";
import { JWTPayload, Bindings, StoredTrack } from "./types";
import * as db from "./database";
import {
  clearAuthCookie,
  completeDiscordLogin,
  startDiscordLogin,
} from "./discord-login";
import {
  CallsApiError,
  closeTracks,
  isSessionActive,
  renegotiateSession,
  startIngest,
  startPlay,
  LiveNotFoundError,
} from "./calls";
import { createLiveToken } from "./live-token";
import { hashedBearerAuth } from "./hashed-bearer-auth";
import { logger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { jwt } from "hono/jwt";
import { hashTokenWithPepper } from "./token-hash";

const app = new Hono<{ Bindings: Bindings }>();

function hasCloseTrackErrors(
  response: Awaited<ReturnType<typeof closeTracks>>,
) {
  return (
    !!response.errorCode || !!response.tracks?.some((track) => track.errorCode)
  );
}

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

function getRequestedTrackMids(requestUrl: string): string[] {
  const mids = new URL(requestUrl).searchParams.getAll("mid");
  return [...new Set(mids.map((mid) => mid.trim()).filter(Boolean))];
}

function createWhepCloseTracks(
  sessionId: string,
  mids: string[],
): StoredTrack[] {
  return mids.map((mid) => ({
    location: "remote" as const,
    mid,
    sessionId,
    trackName: mid,
  }));
}

function isInactiveCallsSessionError(error: unknown): boolean {
  return (
    error instanceof CallsApiError &&
    (error.statusCode === 404 || error.statusCode === 410)
  );
}

function isSdpContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  return contentType.split(";")[0]?.trim().toLowerCase() === "application/sdp";
}

function isCallsPublisherError(error: unknown): error is CallsApiError {
  return (
    error instanceof CallsApiError &&
    (error.statusCode === 400 ||
      error.statusCode === 415 ||
      error.statusCode === 422)
  );
}

function getCallsErrorText(error: CallsApiError, fallback: string): string {
  if (typeof error.responseBody === "string" && error.responseBody.length > 0) {
    return error.responseBody;
  }

  return fallback;
}

function createEmptySuccessResponse(): Response {
  return new Response(null, { status: 204 });
}

function logUnexpectedError(err: unknown): void {
  console.error(
    "Unhandled error:",
    err,
    err instanceof Error ? err.stack : null,
  );
}

function runMiddleware(
  middleware: unknown,
  c: unknown,
  next: unknown,
): Promise<Response | void> {
  const typedMiddleware = middleware as (
    context: unknown,
    next: unknown,
  ) => Promise<Response | void>;
  return typedMiddleware(c, next);
}

function toErrorResponse(
  err: unknown,
  c: Context<{ Bindings: Bindings }>,
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
  hashedBearerAuth<{ Bindings: Bindings }, "/ingest/:userId/*">({
    pepper: (c) => c.env.LIVE_TOKEN_PEPPER,
    token: (c) => {
      const { userId } = c.req.param();
      return db.getLiveTokenHash(c.env.LIVE_DB, userId);
    },
  }),
);

app.get("/ingest/:userId", async () => {
  return createEmptySuccessResponse();
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

  const existingLive = await db.getLiveTrackRecord(c.env.LIVE_DB, userId);
  if (existingLive) {
    const isActive = await isSessionActive(c.env, existingLive.sessionId);
    if (isActive) {
      return c.text("A live stream is already active for this user", 400);
    }

    await db.deleteTracksForSession(
      c.env.LIVE_DB,
      userId,
      existingLive.sessionId,
    );
  }

  try {
    const result = await startIngest(c.env, userId, sdpOffer);

    // トラック情報をデータベースに保存（session_idも含める）
    await db.setTracks(c.env.LIVE_DB, userId, result.sessionId, result.tracks);

    return c.body(result.sdpAnswer, 201, {
      "content-type": "application/sdp",
      etag: `"${result.sessionId}"`,
      location: `/ingest/${userId}/${result.sessionId}`,
    });
  } catch (error) {
    if (isCallsPublisherError(error)) {
      return c.text(
        getCallsErrorText(error, "Failed to negotiate ingest session"),
        error.statusCode as 400 | 415 | 422,
      );
    }

    throw error;
  }
});

// ライブ配信終了エンドポイント
// 配信セッションを削除し、関連データを清理
app.get("/ingest/:userId/:sessionId", async () => {
  return createEmptySuccessResponse();
});

app.delete("/ingest/:userId/:sessionId", async (c) => {
  const { userId, sessionId } = c.req.param();

  const existingLive = await db.getLiveTrackRecord(c.env.LIVE_DB, userId);
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

  try {
    const closeResponse = await closeTracks(
      c.env,
      sessionId,
      existingLive.tracks,
    );

    if (
      closeResponse.errorCode ||
      closeResponse.tracks?.some((track) => track.errorCode)
    ) {
      console.error(
        `Calls reported track close errors for user ${userId}:`,
        closeResponse,
      );
      return c.text("Failed to close live tracks", 502);
    }
  } catch (error) {
    if (error instanceof CallsApiError && error.statusCode === 404) {
      // 既にセッションやトラックが消えている場合は、D1だけ掃除すればよい
    } else if (error instanceof CallsApiError) {
      console.error(`Failed to close live tracks for user ${userId}:`, error);
      return c.text("Failed to close live tracks", 502);
    } else {
      throw error;
    }
  }

  const deleted = await db.deleteTracksForSession(
    c.env.LIVE_DB,
    userId,
    sessionId,
  );
  if (!deleted) {
    return c.text("Failed to delete the requested live stream", 400);
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
  return runMiddleware(
    jwt({
      secret: c.env.JWT_SECRET,
      cookie: "authtoken",
      alg: "HS256",
    }),
    c,
    next,
  );
});

// ライブ視聴開始エンドポイント（WHEP）
// 視聴者からのSDP Offerを受け取り、配信されているトラックへの接続セッションを作成
app.get("/play/:userId", async () => {
  return createEmptySuccessResponse();
});

app.post("/play/:userId", async (c) => {
  const { userId } = c.req.param();

  // JWTペイロードからユーザー情報を取得してログ出力
  const jwtPayload = c.get("jwtPayload") as JWTPayload;
  console.log(
    `User ${jwtPayload.displayName} (${jwtPayload.userId}) is trying to play user: ${userId}`,
  );

  // Calls APIクライアントを初期化
  const liveTrackRecord = await db.getLiveTrackRecord(c.env.LIVE_DB, userId);
  const tracks = liveTrackRecord?.tracks ?? [];

  if (liveTrackRecord) {
    const isActive = await isSessionActive(c.env, liveTrackRecord.sessionId);
    if (!isActive) {
      await db.deleteTracksForSession(
        c.env.LIVE_DB,
        userId,
        liveTrackRecord.sessionId,
      );
      return c.text(`Live stream not found: ${userId}`, 404);
    }
  }

  if (!isSdpContentType(c.req.header("content-type"))) {
    return c.text("Content-Type must be application/sdp", 415);
  }

  const sdpOffer = await c.req.text();
  if (!sdpOffer || sdpOffer.trim().length === 0) {
    return c.text("SDP offer is required", 400);
  }

  try {
    const result = await startPlay(c.env, userId, tracks, sdpOffer);
    const status = result.sdpType === "offer" ? 406 : 201;

    return c.body(result.sdpAnswer, status, {
      "content-type": "application/sdp",
      etag: `"${result.sessionId}"`,
      location: createPlaySessionLocation(
        c.req.url,
        userId,
        result.sessionId,
        result.tracks,
      ),
    });
  } catch (error) {
    console.error(
      `Failed to start play for user ${userId} by user ${jwtPayload.userId}:`,
      error,
    );
    if (error instanceof LiveNotFoundError) {
      return c.text(`Live stream not found: ${userId}`, 404);
    }
    if (error instanceof CallsApiError && error.statusCode === 404) {
      if (liveTrackRecord) {
        await db.deleteTracksForSession(
          c.env.LIVE_DB,
          userId,
          liveTrackRecord.sessionId,
        );
      }
      return c.text(`Live stream not found: ${userId}`, 404);
    }
    if (isCallsPublisherError(error)) {
      return c.text(
        getCallsErrorText(error, "Failed to negotiate playback session"),
        error.statusCode as 400 | 415 | 422,
      );
    }

    throw error;
  }
});

// ライブ視聴セッション管理エンドポイント
app.get("/play/:userId/:sessionId", async () => {
  return createEmptySuccessResponse();
});

app
  .delete("/play/:userId/:sessionId", async (c) => {
    const { sessionId } = c.req.param();
    const mids = getRequestedTrackMids(c.req.url);
    if (mids.length === 0) {
      return c.text("WHEP session track mids are required", 400);
    }

    try {
      const closeResponse = await closeTracks(
        c.env,
        sessionId,
        createWhepCloseTracks(sessionId, mids),
      );
      if (hasCloseTrackErrors(closeResponse)) {
        console.error(
          `Calls reported WHEP session close errors for session ${sessionId}:`,
          closeResponse,
        );
        return c.text("Failed to close WHEP session", 502);
      }
    } catch (error) {
      if (!isInactiveCallsSessionError(error)) {
        console.error(`Failed to close WHEP session ${sessionId}:`, error);
        return c.text("Failed to close WHEP session", 502);
      }
    }

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

    try {
      await renegotiateSession(c.env, sessionId, sdpAnswer);
    } catch (error) {
      if (isCallsPublisherError(error)) {
        return c.text(
          getCallsErrorText(error, "Failed to submit WHEP answer"),
          error.statusCode as 400 | 415 | 422,
        );
      }

      throw error;
    }

    return c.body(null, 204);
  });

// API routes用の認証ミドルウェア
app.use("/api/*", async (c, next) => {
  return runMiddleware(
    jwt({
      secret: c.env.JWT_SECRET,
      cookie: "authtoken",
      alg: "HS256",
    }),
    c,
    next,
  );
});

// ユーザー情報を取得するAPIエンドポイント
// JWTトークンからユーザー情報を抽出して返す
app.get("/api/me", async (c) => {
  const jwtPayload = c.get("jwtPayload") as JWTPayload;

  return c.json({
    userId: jwtPayload.userId,
    displayName: jwtPayload.displayName,
  });
});

// 配信用トークンを発行するAPIエンドポイント
// 何度でも発行可能で、新しいトークンで上書きされる
// トークンは作成時にのみ表示される
app.post("/api/me/livetoken", async (c) => {
  const jwtPayload = c.get("jwtPayload") as JWTPayload;
  const userId = jwtPayload.userId;
  const token = createLiveToken();
  try {
    const tokenHash = await hashTokenWithPepper(c.env.LIVE_TOKEN_PEPPER, token);
    // データベースに保存（既存があれば上書き）
    await db.setLiveToken(c.env.LIVE_DB, userId, tokenHash);
    return c.json({
      success: true,
      token,
    });
  } catch (error) {
    console.error("Failed to save live token:", error);
    throw error;
  }
});

// 配信用トークンの発行状況を確認するAPIエンドポイント
// 副作用なし：トークンは表示せず、発行状況のみを返す
app.get("/api/me/livetoken", async (c) => {
  const jwtPayload = c.get("jwtPayload") as JWTPayload;
  const userId = jwtPayload.userId;
  try {
    const hasToken = await db.hasLiveToken(c.env.LIVE_DB, userId);
    return c.json({
      hasToken: hasToken,
    });
  } catch (error) {
    console.error(`Failed to check live token for user ${userId}:`, error);
    throw error;
  }
});

app.get("/api/lives", async (c) => {
  const lives = await db.getAllLives(c.env.LIVE_DB);
  return c.json(lives);
});

export default app;
