import { Context, Hono } from "hono";
import { JWTPayload, Bindings, DiscordGuildMember } from "./types";
import * as db from "./database";
import { getGuildMember } from "./discord";
import { calcJwtTimestamps, JWT_DURATION_SECONDS } from "./jwt-utils";
import {
  CallsApiError,
  closeTracks,
  isSessionActive,
  renegotiateSession,
  startIngest,
  startPlay,
  LiveNotFoundError,
} from "./calls";
import { StatusCode } from "hono/utils/http-status";
import { logger } from "hono/logger";
import { bearerAuth } from "hono/bearer-auth";
import { deleteCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { discordAuth, revokeToken } from "@hono/oauth-providers/discord";
import { jwt, sign } from "hono/jwt";

const app = new Hono<{ Bindings: Bindings }>();

function logUnexpectedError(err: unknown): void {
  console.error(
    "Unhandled error:",
    err,
    err instanceof Error ? err.stack : null,
  );
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
app.use("/ingest/:userId/*", async (c, next) => {
  const { userId } = c.req.param();

  // userIdでデータベースからトークンを取得
  const expectedToken = await db.getLiveToken(c.env.LIVE_DB, userId);
  if (!expectedToken) {
    return c.text("No token found for this user ID", 401);
  }

  return bearerAuth({ token: expectedToken })(c, next);
});

// WHIP配信用のCORSプリフライトリクエスト処理
app.options("/ingest/:userId/:settionId?", async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "accept-post": "application/sdp",
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "content-type,authorization,if-match",
      "access-control-allow-methods": "PATCH,POST,PUT,DELETE,OPTIONS",
      "access-control-allow-origin": "*",
      "access-control-expose-headers":
        "x-thunderclap,location,link,accept-post,accept-patch,etag",
      link: '<stun:stun.cloudflare.com:3478>; rel="ice-server"',
    },
  });
});

// ライブ配信開始エンドポイント（WHIP）
// 配信者からのSDP Offerを受け取り、Cloudflareセッションを作成
app
  .post("/ingest/:userId", async (c) => {
    const { userId } = c.req.param();
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

    const result = await startIngest(c.env, userId, sdpOffer);

    // トラック情報をデータベースに保存（session_idも含める）
    await db.setTracks(c.env.LIVE_DB, userId, result.sessionId, result.tracks);

    return c.body(result.sdpAnswer, 201, {
      "content-type": "application/sdp",
      "protocol-version": "draft-ietf-wish-whip-06",
      etag: `"${result.sessionId}"`,
      location: `/ingest/${userId}/${result.sessionId}`,
    });
  })
  .all(async () => {
    return new Response("Not supported", { status: 400 });
  });

// ライブ配信終了エンドポイント
// 配信セッションを削除し、関連データを清理
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

// Discord OAuth認証設定
app.use("/login", async (c, next) => {
  return discordAuth({
    client_id: c.env.DISCORD_CLIENT_ID,
    client_secret: c.env.DISCORD_CLIENT_SECRET,
    scope: ["identify", "guilds", "guilds.members.read"],
  })(c, next);
});

// OAuth認証後のトークン取り消し処理
app.use("/login", async (c, next) => {
  const oauthToken = c.get("token");
  if (!oauthToken) {
    return c.text("Unauthorized", 401);
  }
  try {
    await next();
  } finally {
    try {
      await revokeToken(
        c.env.DISCORD_CLIENT_ID,
        c.env.DISCORD_CLIENT_SECRET,
        oauthToken.token,
      );
    } catch (error) {
      // トークン取り消しの失敗は致命的ではないので、ログのみ出力
      console.warn("Failed to revoke OAuth token:", error);
    }
  }
});

// Discord認証とJWT発行エンドポイント
// Discordユーザーを認証し、ギルドメンバーシップを確認後JWTトークンを発行
app.get("/login", async (c) => {
  const user = c.get("user-discord");
  const oauthToken = c.get("token");
  if (!user || !oauthToken) {
    return c.text("Unauthorized", 401);
  }
  // ユーザーが認証済みギルドのメンバーかどうかをチェック
  let member: DiscordGuildMember;
  try {
    member = await getGuildMember(oauthToken.token, c.env.AUTHORIZED_GUILD_ID);
  } catch (error) {
    console.error(
      `Error fetching guild member for user ${String(user.id)}:`,
      error,
    );

    if (error instanceof Error) {
      return c.text(`Unauthorized: ${error.message}`, 401);
    }

    return c.text("Unauthorized: Failed to fetch guild member", 401);
  }

  const displayName =
    member.nick || member.user.global_name || member.user.username;

  await db.setUser(c.env.LIVE_DB, {
    userId: member.user.id,
    displayName,
  });

  const { iat, exp } = calcJwtTimestamps(JWT_DURATION_SECONDS.ONE_DAY);
  const payload: JWTPayload = {
    iat,
    exp,
    userId: member.user.id,
    displayName,
  };
  const jwtToken = await sign(payload, c.env.JWT_SECRET, "HS256");

  // 本番環境ではsecure: true、ローカル開発ではsecure: false
  const isProduction = c.env.ENVIRONMENT === "production";

  setCookie(c, "authtoken", jwtToken, {
    expires: new Date(Date.now() + JWT_DURATION_SECONDS.ONE_DAY * 1000),
    httpOnly: true,
    secure: isProduction,
    sameSite: "Strict",
  });
  return c.redirect("/");
});

app.post("/logout", async (c) => {
  deleteCookie(c, "authtoken", {
    secure: c.env.ENVIRONMENT === "production",
  });
  return c.redirect("/");
});

// ライブ視聴用エンドポイントの認証ミドルウェア
app.use("/play/*", async (c, next) => {
  return jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  })(c, next);
});

// ライブ視聴開始エンドポイント（WHEP）
// 視聴者からのSDP Offerを受け取り、配信されているトラックへの接続セッションを作成
app
  .post("/play/:userId", async (c) => {
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

    const sdpOffer = await c.req.text();

    try {
      const result = await startPlay(c.env, userId, tracks, sdpOffer);

      return c.body(result.sdpAnswer, 201, {
        "access-control-expose-headers": "location",
        "content-type": "application/sdp",
        "protocol-version": "draft-ietf-wish-whep-00",
        etag: `"${result.sessionId}"`,
        location: `/play/${userId}/${result.sessionId}`,
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

      throw error;
    }
  })
  .all(async () => {
    return new Response("Not supported", { status: 404 });
  });

// ライブ視聴セッション管理エンドポイント
app
  .delete("/play/:userId/:sessionId", async (c) => {
    return c.body("OK", 200);
  }) // ICE候補やセッション再交渉用のPATCHエンドポイント
  .patch(async (c) => {
    const { sessionId } = c.req.param();

    const sdpAnswer = await c.req.text();
    if (!sdpAnswer || sdpAnswer.trim().length === 0) {
      return c.text("SDP answer is required", 400);
    }

    const response = await renegotiateSession(c.env, sessionId, sdpAnswer);
    return c.body(null, response.status as StatusCode);
  });

// API routes用の認証ミドルウェア
app.use("/api/*", async (c, next) => {
  return jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  })(c, next);
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
  const userId = jwtPayload.userId; // ランダムなトークンを生成（32バイト）
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const token = Array.from(randomBytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  try {
    // データベースに保存（既存があれば上書き）
    await db.setLiveToken(c.env.LIVE_DB, userId, token);
    return c.json({
      success: true,
      token: token,
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
