import { Hono } from "hono";
import {
  NewSessionResponse,
  NewTracksResponse,
  TrackLocator,
  JWTPayload,
  Bindings,
} from "./types";
import * as db from "./database";
import { getGuildMember } from "./discord";
import { calculateJwtTimestamps, JWT_DURATION_SECONDS } from "./jwt-utils";
import { StatusCode } from "hono/utils/http-status";
import { logger } from "hono/logger";
import { bearerAuth } from "hono/bearer-auth";
import { setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { discordAuth, revokeToken } from "@hono/oauth-providers/discord";
import { jwt, sign } from "hono/jwt";

const app = new Hono<{ Bindings: Bindings }>();

app.use(logger());

app.use("/ingest/*", async (c, next) => {
  return bearerAuth({ token: c.env.INGEST_BEARER_TOKEN })(c, next);
});

app.options("/ingest/:liveId/:settionId?", async () => {
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

app
  .post("/ingest/:liveId", async (c) => {
    const { liveId } = c.req.param();
    const CallsEndpoint = `https://rtc.live.cloudflare.com/v1/apps/${c.env.CALLS_APP_ID}`;
    const CallsEndpointHeaders = {
      Authorization: `Bearer ${c.env.CALLS_APP_SECRET}`,
    };
    const newSessionResult = (await (
      await fetch(`${CallsEndpoint}/sessions/new`, {
        method: "POST",
        headers: CallsEndpointHeaders,
      })
    ).json()) as NewSessionResponse;
    const newTracksBody = {
      sessionDescription: {
        type: "offer",
        sdp: await c.req.text(),
      },
      autoDiscover: true,
    };
    const newTracksResult = (await (
      await fetch(
        `${CallsEndpoint}/sessions/${newSessionResult.sessionId}/tracks/new`,
        {
          method: "POST",
          headers: CallsEndpointHeaders,
          body: JSON.stringify(newTracksBody),
        }
      )
    ).json()) as NewTracksResponse;
    const tracks = newTracksResult.tracks.map((track) => {
      return {
        location: "remote",
        sessionId: newSessionResult.sessionId,
        trackName: track.trackName,
      };
    }) as TrackLocator[];
    await db.setTracks(c.env.LIVE_DB, liveId, tracks);
    return c.body(newTracksResult.sessionDescription.sdp, 201, {
      "content-type": "application/sdp",
      "protocol-version": "draft-ietf-wish-whip-06",
      etag: `"${newSessionResult.sessionId}"`,
      location: `/ingest/${liveId}/${newSessionResult.sessionId}`,
    });
  })
  .all(async (c) => {
    return c.body("Not supported", 400);
  });

app.delete("/ingest/:liveId/:sessionId", async (c) => {
  const { liveId } = c.req.param();
  await db.deleteTracks(c.env.LIVE_DB, liveId);
  return c.text("OK", 200);
});

app.use("/login", async (c, next) => {
  return discordAuth({
    client_id: c.env.DISCORD_CLIENT_ID,
    client_secret: c.env.DISCORD_CLIENT_SECRET,
    scope: ["identify", "guilds", "guilds.members.read"],
  })(c, next);
});

app.use("/login", async (c, next) => {
  const oauthToken = c.get("token");
  if (!oauthToken) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  await next();
  await revokeToken(
    c.env.DISCORD_CLIENT_ID,
    c.env.DISCORD_CLIENT_SECRET,
    oauthToken.token
  );
});

app.get("/login", async (c) => {
  const user = c.get("user-discord");
  const oauthToken = c.get("token");
  if (!user || !oauthToken) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  // ユーザーが認証済みギルドのメンバーかどうかをチェック
  let member;
  try {
    member = await getGuildMember(oauthToken.token, c.env.AUTHORIZED_GUILD_ID);
  } catch (error) {
    console.error("Error fetching guild member:", error);
    return c.body("Unauthorized: Failed to fetch guild member", 401);
  }

  const { iat, exp } = calculateJwtTimestamps(JWT_DURATION_SECONDS.ONE_DAY);
  const payload: JWTPayload = {
    iat,
    exp,
    userId: member.user.id,
    displayName: member.nick || member.user.global_name || member.user.username,
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

app.use("/play/*", async (c, next) => {
  return jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  })(c, next);
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
app.get("/api/user", async (c) => {
  const jwtPayload = c.get("jwtPayload") as JWTPayload;

  return c.json({
    success: true,
    user: {
      userId: jwtPayload.userId,
      displayName: jwtPayload.displayName,
    },
  });
});

app
  .post("/play/:liveId", async (c) => {
    const { liveId } = c.req.param();

    // JWTペイロードからユーザー情報を取得してログ出力
    const jwtPayload = c.get("jwtPayload") as JWTPayload;
    console.log(
      `User ${jwtPayload.displayName} (${jwtPayload.userId}) is trying to play live: ${liveId}`
    );
    const CallsEndpoint = `https://rtc.live.cloudflare.com/v1/apps/${c.env.CALLS_APP_ID}`;
    const CallsEndpointHeaders = {
      Authorization: `Bearer ${c.env.CALLS_APP_SECRET}`,
    };
    const tracks = await db.getTracks(c.env.LIVE_DB, liveId);
    if (tracks.length === 0) {
      return c.body("Live not started yet", 404);
    }
    const newSessionResult = (await (
      await fetch(`${CallsEndpoint}/sessions/new`, {
        method: "POST",
        headers: CallsEndpointHeaders,
      })
    ).json()) as NewSessionResponse;
    const remoteOffer = await c.req.text();
    const newTracksBody = {
      tracks: tracks,
      ...(remoteOffer.length > 0
        ? {
            sessionDescription: {
              type: "offer",
              sdp: remoteOffer,
            },
          }
        : {}),
    };
    const newTracksResult = (await (
      await fetch(
        `${CallsEndpoint}/sessions/${newSessionResult.sessionId}/tracks/new`,
        {
          method: "POST",
          headers: CallsEndpointHeaders,
          body: JSON.stringify(newTracksBody),
        }
      )
    ).json()) as NewTracksResponse;
    return c.body(newTracksResult.sessionDescription.sdp, 201, {
      "access-control-expose-headers": "location",
      "content-type": "application/sdp",
      "protocol-version": "draft-ietf-wish-whep-00",
      etag: `"${newSessionResult.sessionId}"`,
      location: `/play/${liveId}/${newSessionResult.sessionId}`,
    });
  })
  .all(async (c) => {
    return c.body("Not supported", 404);
  });

app
  .delete("/play/:liveId/:sessionId", async (c) => {
    return c.body("OK", 200);
  })
  .patch(async (c) => {
    const CallsEndpoint = `https://rtc.live.cloudflare.com/v1/apps/${c.env.CALLS_APP_ID}`;
    const CallsEndpointHeaders = {
      Authorization: `Bearer ${c.env.CALLS_APP_SECRET}`,
    };
    const { sessionId } = c.req.param();
    const renegotiateBody = {
      sessionDescription: {
        type: "answer",
        sdp: await c.req.text(),
      },
    };
    const renegotiateResponse = await fetch(
      `${CallsEndpoint}/sessions/${sessionId}/renegotiate`,
      {
        method: "PUT",
        headers: CallsEndpointHeaders,
        body: JSON.stringify(renegotiateBody),
      }
    );
    return c.body(null, renegotiateResponse.status as StatusCode);
  });

export default app;
