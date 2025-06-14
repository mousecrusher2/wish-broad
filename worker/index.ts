import { Hono } from "hono";
import { JWTPayload, Bindings, DiscordGuildMember } from "./types";
import * as db from "./database";
import { getGuildMember } from "./discord";
import { calculateJwtTimestamps, JWT_DURATION_SECONDS } from "./jwt-utils";
import {
  CallsClient,
  startIngest,
  startPlay,
  LiveNotFoundError,
} from "./calls";
import { StatusCode } from "hono/utils/http-status";
import { logger } from "hono/logger";
import { bearerAuth } from "hono/bearer-auth";
import { setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { discordAuth, revokeToken } from "@hono/oauth-providers/discord";
import { jwt, sign } from "hono/jwt";

const app = new Hono<{ Bindings: Bindings }>();

app.use(logger());

// 配信取り込み用エンドポイントの認証ミドルウェア
app.use("/ingest/:userId/*", async (c, next) => {
  const { userId } = c.req.param();

  // userIdでデータベースからトークンを取得
  const expectedToken = await db.getLiveToken(c.env.LIVE_DB, userId);
  if (!expectedToken) {
    throw new HTTPException(401, {
      message: "No token found for this user ID",
    });
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

    // Calls APIクライアントを初期化
    const callsClient = new CallsClient({
      appId: c.env.CALLS_APP_ID,
      appSecret: c.env.CALLS_APP_SECRET,
    });
    try {
      const sdpOffer = await c.req.text();
      if (!sdpOffer || sdpOffer.trim().length === 0) {
        throw new HTTPException(400, { message: "SDP offer is required" });
      }
      const result = await startIngest(callsClient, userId, sdpOffer);

      // トラック情報をデータベースに保存（session_idも含める）
      await db.setTracks(
        c.env.LIVE_DB,
        userId,
        result.sessionId,
        result.tracks
      );

      return c.body(result.sdpAnswer, 201, {
        "content-type": "application/sdp",
        "protocol-version": "draft-ietf-wish-whip-06",
        etag: `"${result.sessionId}"`,
        location: `/ingest/${userId}/${result.sessionId}`,
      });
    } catch (error) {
      console.error(`Failed to start ingest for user ${userId}:`, error);

      if (error instanceof HTTPException) {
        throw error;
      }

      // サーバーエラーはそのまま例外を素通りさせる
      throw error;
    }
  })
  .all(async (_c) => {
    throw new HTTPException(400, { message: "Not supported" });
  });

// ライブ配信終了エンドポイント
// 配信セッションを削除し、関連データを清理
app.delete("/ingest/:userId/:sessionId", async (c) => {
  const { userId } = c.req.param();
  try {
    await db.deleteTracks(c.env.LIVE_DB, userId);
    return c.text("OK", 200);
  } catch (error) {
    console.error(`Failed to delete tracks for user ${userId}:`, error);
    throw error;
  }
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
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  await next();

  try {
    await revokeToken(
      c.env.DISCORD_CLIENT_ID,
      c.env.DISCORD_CLIENT_SECRET,
      oauthToken.token
    );
  } catch (error) {
    // トークン取り消しの失敗は致命的ではないので、ログのみ出力
    console.warn("Failed to revoke OAuth token:", error);
  }
});

// Discord認証とJWT発行エンドポイント
// Discordユーザーを認証し、ギルドメンバーシップを確認後JWTトークンを発行
app.get("/login", async (c) => {
  const user = c.get("user-discord");
  const oauthToken = c.get("token");
  if (!user || !oauthToken) {
    throw new HTTPException(401, { message: "Unauthorized" });
  } // ユーザーが認証済みギルドのメンバーかどうかをチェック
  let member: DiscordGuildMember;
  try {
    member = await getGuildMember(oauthToken.token, c.env.AUTHORIZED_GUILD_ID);
  } catch (error) {
    console.error(`Error fetching guild member for user ${user.id}:`, error);

    if (error instanceof Error) {
      throw new HTTPException(401, {
        message: `Unauthorized: ${error.message}`,
      });
    }

    throw new HTTPException(401, {
      message: "Unauthorized: Failed to fetch guild member",
    });
  }

  const displayName =
    member.nick || member.user.global_name || member.user.username;

  await db.setUser(c.env.LIVE_DB, {
    userId: member.user.id,
    displayName,
  });

  const { iat, exp } = calculateJwtTimestamps(JWT_DURATION_SECONDS.ONE_DAY);
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
      `User ${jwtPayload.displayName} (${jwtPayload.userId}) is trying to play user: ${userId}`
    );

    // Calls APIクライアントを初期化
    const callsClient = new CallsClient({
      appId: c.env.CALLS_APP_ID,
      appSecret: c.env.CALLS_APP_SECRET,
    });
    try {
      const tracks = await db.getTracks(c.env.LIVE_DB, userId);

      // トラックが存在し、セッションチェックが必要な場合のみチェック実行
      if (tracks.length > 0) {
        const shouldCheck = await db.shouldCheckSession(c.env.LIVE_DB, userId);

        if (shouldCheck) {
          // セッションアクティブチェック
          const ingestSessionId = tracks[0]?.sessionId;
          if (ingestSessionId) {
            const isActive = await callsClient.isSessionActive(ingestSessionId);
            if (!isActive) {
              // セッションが終了している場合、データベースからレコードを削除
              await db.deleteInactiveSession(c.env.LIVE_DB, userId);
              throw new LiveNotFoundError(userId);
            }

            // セッションチェック時刻を更新
            await db.updateSessionCheckTime(c.env.LIVE_DB, userId);
          }
        }
      }

      const sdpOffer = await c.req.text();
      const result = await startPlay(callsClient, userId, tracks, sdpOffer);

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
        error
      );
      if (error instanceof HTTPException) {
        throw error;
      }
      if (error instanceof LiveNotFoundError) {
        throw new HTTPException(404, {
          message: `Live stream not found: ${userId}`,
        });
      }

      // サーバーエラーはそのまま例外を素通りさせる
      throw error;
    }
  })
  .all(async (_c) => {
    throw new HTTPException(404, { message: "Not supported" });
  });

// ライブ視聴セッション管理エンドポイント
app
  .delete("/play/:userId/:sessionId", async (c) => {
    return c.body("OK", 200);
  }) // ICE候補やセッション再交渉用のPATCHエンドポイント
  .patch(async (c) => {
    const { sessionId } = c.req.param();

    // Calls APIクライアントを初期化
    const callsClient = new CallsClient({
      appId: c.env.CALLS_APP_ID,
      appSecret: c.env.CALLS_APP_SECRET,
    });

    try {
      const sdpAnswer = await c.req.text();
      if (!sdpAnswer || sdpAnswer.trim().length === 0) {
        throw new HTTPException(400, { message: "SDP answer is required" });
      }

      const response = await callsClient.renegotiateSession(
        sessionId,
        sdpAnswer
      );
      return c.body(null, response.status as StatusCode);
    } catch (error) {
      console.error(`Failed to renegotiate session ${sessionId}:`, error);
      if (error instanceof HTTPException) {
        throw error;
      }

      // サーバーエラーはそのまま例外を素通りさせる
      throw error;
    }
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
    byte.toString(16).padStart(2, "0")
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
