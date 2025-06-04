import { Hono } from "hono";
import { NewSessionResponse, NewTracksResponse, TrackLocator } from "./types";
import { StatusCode } from "hono/utils/http-status";
import { DurableObject } from "cloudflare:workers";
import { logger } from "hono/logger";
import { bearerAuth } from "hono/bearer-auth";
import { setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { discordAuth, revokeToken } from "@hono/oauth-providers/discord";
import { jwt, sign } from "hono/jwt";

interface Env {
  CALLS_API: string;
  CALLS_APP_ID: string;
  CALLS_APP_SECRET: string;
  LIVE_STORE: DurableObjectNamespace<LiveStore>;
}

export class LiveStore extends DurableObject {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async setTracks(tracks: TrackLocator[]): Promise<void> {
    await this.ctx.storage.put("tracks", tracks);
  }

  async getTracks(): Promise<TrackLocator[]> {
    return (await this.ctx.storage.get("tracks")) || [];
  }

  async deleteTracks(): Promise<void> {
    await this.ctx.storage.delete("tracks");
  }
}

export type Bindings = {
  CALLS_APP_ID: string;
  CALLS_APP_SECRET: string;
  INGEST_BEARER_TOKEN: string;
  JWT_SECRET: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  LIVE_STORE: DurableObjectNamespace<LiveStore>;
};

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
    let stub = c.env.LIVE_STORE.get(c.env.LIVE_STORE.idFromName(liveId));
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
    await stub.setTracks(tracks);
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
  let stub = c.env.LIVE_STORE.get(c.env.LIVE_STORE.idFromName(liveId));
  stub.deleteTracks();
  return c.text("OK", 200);
});

app.use("/login", async (c, next) => {
  return discordAuth({
    client_id: c.env.DISCORD_CLIENT_ID,
    client_secret: c.env.DISCORD_CLIENT_SECRET,
    scope: ["identify", "guilds"],
  })(c, next);
});

app.use("/login", async (c, next) => {
  const token = c.get("token");
  if (!token) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  await next();
  await revokeToken(
    c.env.DISCORD_CLIENT_ID,
    c.env.DISCORD_CLIENT_SECRET,
    token.token
  );
});

app.get("/login", async (c) => {
  const user = c.get("user-discord");
  if (!user) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }
  if (user.id !== "890371776893292574") {
    return c.body("Unauthorized", 401);
  }
  const payload = {
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24,
  };
  const token = await sign(payload, c.env.JWT_SECRET, "HS256");
  setCookie(c, "authtoken", token, {
    expires: new Date(Date.now() + 60 * 60 * 24 * 1000),
    httpOnly: true,
    // secure: true,
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

app
  .post("/play/:liveId", async (c) => {
    const { liveId } = c.req.param();
    const CallsEndpoint = `https://rtc.live.cloudflare.com/v1/apps/${c.env.CALLS_APP_ID}`;
    const CallsEndpointHeaders = {
      Authorization: `Bearer ${c.env.CALLS_APP_SECRET}`,
    };
    let stub = c.env.LIVE_STORE.get(c.env.LIVE_STORE.idFromName(liveId));
    const tracks = (await stub.getTracks()) as TrackLocator[];
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
