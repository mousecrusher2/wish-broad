// OBS からの WHIP インジェスト。認証には視聴者用 JWT ではなく、ユーザーごとの配信トークンを使用する。
import { endIngest, startIngest } from "../live/ingest";
import { logInfo } from "../lib/logger";
import { hashedBearerAuth } from "../middleware/hashed-bearer-auth";
import { getLiveState } from "../state/live-state";
import type { AppEnv } from "../types";
import { createApp } from "./create-app";
import { readSdpBody } from "./sdp";

export const ingestRoutes = createApp();

ingestRoutes.use(
  "/:userId",
  hashedBearerAuth<AppEnv, "/:userId">({
    pepper: (c) => c.env.LIVE_TOKEN_PEPPER,
    token: (c) => {
      const { userId } = c.req.param();
      return getLiveState(c.env).getLiveTokenHash(userId);
    },
  }),
);
ingestRoutes.use(
  "/:userId/:sessionId",
  hashedBearerAuth<AppEnv, "/:userId/:sessionId">({
    pepper: (c) => c.env.LIVE_TOKEN_PEPPER,
    token: (c) => {
      const { userId } = c.req.param();
      return getLiveState(c.env).getLiveTokenHash(userId);
    },
  }),
);
ingestRoutes.use("/:userId", async (c, next) => {
  const { userId } = c.req.param();
  logInfo(c.env, "ingest.request", { userId });
  await next();
});
ingestRoutes.use("/:userId/:sessionId", async (c, next) => {
  const { sessionId, userId } = c.req.param();
  logInfo(c.env, "ingest.request", { sessionId, userId });
  await next();
});

ingestRoutes.get("/:userId", async (c) => {
  return c.body(null, 204);
});

// WHIP インジェストの開始。
ingestRoutes.post("/:userId", async (c) => {
  const { userId } = c.req.param();
  const sdpOffer = await readSdpBody(c, "offer");
  if (sdpOffer instanceof Response) {
    return sdpOffer;
  }

  const notifyParam = c.req.query("notify");
  const result = await startIngest(
    c.env,
    c.executionCtx,
    userId,
    sdpOffer,
    notifyParam === "false" || notifyParam === "0"
      ? null
      : new URL("/", c.req.url).toString(),
  );
  switch (result.kind) {
    case "started":
    case "resumed":
      return c.body(result.session.sdpAnswer, 201, {
        "content-type": "application/sdp",
        etag: `"${result.session.sessionId}"`,
        location: `/ingest/${userId}/${result.session.sessionId}`,
      });
    case "already_active":
      return c.text("A live stream is already active for this user", 400);
    case "session_check_failed":
      return c.text("Failed to verify ingest session status", 502);
    case "negotiation_rejected":
      return c.text(result.text, result.status);
    case "negotiation_failed":
      return c.text("Internal Server Error", 500);
  }
});

ingestRoutes.get("/:userId/:sessionId", async () => {
  return new Response(null, { status: 204 });
});

// WHIP インジェストの終了。現在保存されているセッションのみがそのインジェストを終了できる。
ingestRoutes.delete("/:userId/:sessionId", async (c) => {
  const { userId, sessionId } = c.req.param();
  switch (await endIngest(c.env, c.executionCtx, userId, sessionId)) {
    case "grace_started":
    case "already_in_grace":
      return c.text("OK", 200);
    case "no_live":
      return c.text("No live stream found for this user", 400);
    case "session_mismatch":
      return c.text("Session ID does not match the active live stream", 400);
    case "invalid_stored_tracks":
      return c.text("Stored live track data is invalid", 500);
    case "grace_not_started":
      return c.text("Failed to delete the requested live stream", 400);
  }
});
