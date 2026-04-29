/* eslint-disable sonarjs/cognitive-complexity */
import type { Context } from "hono";
import { HonoBase } from "hono/hono-base";
import { LinearRouter } from "hono/router/linear-router";
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
import { HTTPException } from "hono/http-exception";
import { jwt } from "hono/jwt";
import { csrf } from "hono/csrf";
import {
  deleteLiveStartedNotification,
  sendLiveStartedNotification,
} from "./notifications";
import { hashTokenWithPepper } from "./token-hash";
import { generateTurnIceServers } from "./turn";
import { createErrorLogFields, logError, logInfo, logWarn } from "./logger";

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
  // Track close is cleanup only. D1 is already updated before this runs, so a
  // transient Calls failure should not keep invalid track locators visible.
  c.executionCtx.waitUntil(
    closeTracks(c.env, sessionId, tracks).then((closeResult) => {
      if (closeResult.isErr()) {
        if (
          closeResult.error.kind !== "session_not_found" &&
          closeResult.error.kind !== "session_gone"
        ) {
          logWarn(c.env, "track_close.failed", {
            ...createErrorLogFields(closeResult.error),
            message: failureLabel,
            sessionId,
          });
        }
        return;
      }

      if (
        closeResult.value.errorCode ||
        closeResult.value.tracks?.some((track) => track.errorCode)
      ) {
        logWarn(c.env, "track_close.sfu_errors", {
          message: errorLabel,
          response: closeResult.value,
          sessionId,
        });
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
    logWarn(c.env, "live_notification.send_failed", {
      ...createErrorLogFields(notificationResult.error),
      sessionId,
      userId,
    });
    return;
  }

  const { messageId } = notificationResult.value;

  // Notifications are tied to the exact live session. If that row has already
  // disappeared, delete the Discord message instead of leaving an orphan.
  type PersistNotificationResult =
    | { ok: true; saved: boolean }
    | { ok: false; error: Error };
  const persistResult: PersistNotificationResult = await db
    .setLiveNotificationMessageId(c.env.LIVE_DB, userId, sessionId, messageId)
    .then((saved): PersistNotificationResult => ({ ok: true, saved }))
    .catch((error: Error): PersistNotificationResult => ({ ok: false, error }));

  if (!persistResult.ok) {
    logWarn(c.env, "live_notification.persist_failed", {
      ...createErrorLogFields(persistResult.error),
      messageId,
      sessionId,
      userId,
    });
  }

  if (persistResult.ok && persistResult.saved) {
    return;
  }

  const deleteResult = await deleteLiveStartedNotification(c.env, messageId);
  if (deleteResult.isErr()) {
    logWarn(c.env, "live_notification.orphan_delete_failed", {
      ...createErrorLogFields(deleteResult.error),
      messageId,
      sessionId,
      userId,
    });
  }
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

// OBS ingest authenticates with the per-user live token, not the viewer JWT.
app.use(
  "/ingest/:userId",
  hashedBearerAuth<AppEnv, "/ingest/:userId">({
    pepper: (c) => c.env.LIVE_TOKEN_PEPPER,
    token: (c) => {
      const { userId } = c.req.param();
      return db.getLiveTokenHash(c.env.LIVE_DB, userId);
    },
  }),
);
app.use(
  "/ingest/:userId/:sessionId",
  hashedBearerAuth<AppEnv, "/ingest/:userId/:sessionId">({
    pepper: (c) => c.env.LIVE_TOKEN_PEPPER,
    token: (c) => {
      const { userId } = c.req.param();
      return db.getLiveTokenHash(c.env.LIVE_DB, userId);
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

// WHIP ingest start. The Worker stores the resulting Calls session as the
// current live row for this owner.
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
    // Avoid global SFU sweeps in Workers. Only check the one row that blocks
    // this ingest attempt, then remove it if Calls has already garbage-collected
    // the underlying session.
    const isActiveResult = await isSessionActive(c.env, existingLive.sessionId);
    if (isActiveResult.isErr()) {
      logError(c.env, "ingest.session_activity_check_failed", {
        ...createErrorLogFields(isActiveResult.error),
        sessionId: existingLive.sessionId,
        userId,
      });
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
      if (
        notificationMessageId !== null &&
        notificationMessageId !== undefined
      ) {
        c.executionCtx.waitUntil(
          deleteLiveStartedNotification(c.env, notificationMessageId).then(
            (deleteResult) => {
              if (deleteResult.isErr()) {
                logWarn(c.env, "live_notification.delete_failed", {
                  ...createErrorLogFields(deleteResult.error),
                  messageId: notificationMessageId,
                  sessionId: existingLive.sessionId,
                  userId,
                });
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

    logError(c.env, "ingest.negotiation_failed", {
      ...createErrorLogFields(ingestResult.error),
      userId,
    });
    return c.text("Internal Server Error", 500);
  }

  const result = ingestResult.value;
  // The live row is a pointer to this exact Calls session and track set. OBS
  // reconnects create new SDP, sessions, and mids, so stale rows must not be
  // reused across ingests.
  await db.insertLive(c.env.LIVE_DB, userId, result.sessionId, result.tracks);

  const notifyParam = c.req.query("notify");
  if (notifyParam !== "false" && notifyParam !== "0") {
    c.executionCtx.waitUntil(
      sendLiveStartNotification(
        c,
        userId,
        result.sessionId,
        createSiteRootLocation(c.req.url),
      ),
    );
  }

  return c.body(result.sdpAnswer, 201, {
    "content-type": "application/sdp",
    etag: `"${result.sessionId}"`,
    location: `/ingest/${userId}/${result.sessionId}`,
  });
});

// WHIP ingest end. Only the currently stored session can delete the live row.
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

  // Delete the row immediately rather than keeping a pending-end state. Workers
  // cannot reliably own timers, and the stored track locators are invalid once
  // this ingest session is no longer current.
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
      deleteLiveStartedNotification(
        c.env,
        existingLive.notificationMessageId,
      ).then((deleteResult) => {
        if (deleteResult.isErr()) {
          logWarn(c.env, "live_notification.delete_failed", {
            ...createErrorLogFields(deleteResult.error),
            messageId: existingLive.notificationMessageId,
            sessionId,
            userId,
          });
        }
      }),
    );
  }

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

// Viewing is restricted to authenticated app users.
app.use("/play/*", csrf());
app.use("/play/*", async (c, next) => {
  const middleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  return middleware(c, next);
});
app.use("/play/*", async (c, next) => {
  const jwtPayload = c.get("jwtPayload");
  logInfo(c.env, "play.request", { userId: jwtPayload.userId });
  await next();
});

// WHEP playback start. This is intentionally app-specific and cookie-protected,
// not a public generic WHEP endpoint.
app.get("/play/:userId", async (c) => {
  return c.body(null, 204);
});

app.post("/play/:userId", async (c) => {
  const { userId } = c.req.param();

  const jwtPayload = c.get("jwtPayload");

  const liveTrackRecord = await db.getLive(c.env.LIVE_DB, userId);
  const tracks = liveTrackRecord?.tracks ?? [];
  let hasActiveSession = false;
  if (liveTrackRecord) {
    // Playback names one live owner, so this is the cheapest safe point to
    // reconcile stale D1 state with Calls without scanning every live row.
    const isActiveResult = await isSessionActive(
      c.env,
      liveTrackRecord.sessionId,
    );
    if (isActiveResult.isErr()) {
      logError(c.env, "play.session_activity_check_failed", {
        ...createErrorLogFields(isActiveResult.error),
        sessionId: liveTrackRecord.sessionId,
        userId,
      });
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
      if (
        notificationMessageId !== null &&
        notificationMessageId !== undefined
      ) {
        c.executionCtx.waitUntil(
          deleteLiveStartedNotification(c.env, notificationMessageId).then(
            (deleteResult) => {
              if (deleteResult.isErr()) {
                logWarn(c.env, "live_notification.delete_failed", {
                  ...createErrorLogFields(deleteResult.error),
                  messageId: notificationMessageId,
                  sessionId: liveTrackRecord.sessionId,
                  userId,
                });
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
          if (
            notificationMessageId !== null &&
            notificationMessageId !== undefined
          ) {
            c.executionCtx.waitUntil(
              deleteLiveStartedNotification(c.env, notificationMessageId).then(
                (deleteResult) => {
                  if (deleteResult.isErr()) {
                    logWarn(c.env, "live_notification.delete_failed", {
                      ...createErrorLogFields(deleteResult.error),
                      messageId: notificationMessageId,
                      sessionId: liveTrackRecord.sessionId,
                      userId,
                    });
                  }
                },
              ),
            );
          }
        }
      }
      return c.text(`Live stream not found: ${userId}`, 404);
    }
    logError(c.env, "play.negotiation_failed", {
      ...createErrorLogFields(error),
      userId,
      viewerUserId: jwtPayload.userId,
    });
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

// WHEP playback session cleanup and counter-offer answer submission.
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
  }) // This PATCH submits the answer to a 406 counter-offer, not trickle ICE.
  .patch(async (c) => {
    const { sessionId } = c.req.param();

    if (!isSdpContentType(c.req.header("content-type"))) {
      return c.text("Content-Type must be application/sdp", 415);
    }

    const sdpAnswer = await c.req.text();
    if (!sdpAnswer || sdpAnswer.trim().length === 0) {
      return c.text("SDP answer is required", 400);
    }

    const renegotiationResult = await renegotiateSession(
      c.env,
      sessionId,
      sdpAnswer,
    );
    if (renegotiationResult.isErr()) {
      const negotiationError =
        renegotiationResult.error.toNegotiationClientError(
          "Failed to submit WHEP answer",
        );
      if (negotiationError) {
        return c.text(negotiationError.text, negotiationError.status);
      }

      logError(c.env, "play.answer_submission_failed", {
        ...createErrorLogFields(renegotiationResult.error),
        sessionId,
      });
      return c.text("Failed to submit WHEP answer", 502);
    }

    return c.body(null, 204);
  });

// All /api routes are browser APIs that require the app JWT cookie.
app.use("/api/*", csrf());
app.use("/api/*", async (c, next) => {
  const middleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
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
  // Keep TURN credentials behind the authenticated Worker API. The browser
  // client is not intended to be a generic unauthenticated WHEP endpoint client.
  const turnResult = await generateTurnIceServers(c.env, jwtPayload.userId);
  if (turnResult.isErr()) {
    logError(c.env, "turn_credentials.generate_failed", {
      ...createErrorLogFields(turnResult.error),
      userId: jwtPayload.userId,
    });
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

// Live tokens can be rotated at any time. Return the raw token only on creation;
// D1 stores only the peppered HMAC.
app.post("/api/me/livetoken", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  const userId = jwtPayload.userId;
  const token = createLiveToken();
  const tokenHash = await hashTokenWithPepper(c.env.LIVE_TOKEN_PEPPER, token);

  type SaveTokenResult = { ok: true } | { ok: false; error: Error };
  const saveResult: SaveTokenResult = await db
    .setLiveToken(c.env.LIVE_DB, userId, tokenHash)
    .then((): SaveTokenResult => ({ ok: true }))
    .catch((error: Error): SaveTokenResult => ({ ok: false, error }));
  if (!saveResult.ok) {
    logError(c.env, "live_token.save_failed", {
      ...createErrorLogFields(saveResult.error),
      userId,
    });
    return c.text("Failed to save live token", 500);
  }

  return c.json({
    success: true,
    token,
  });
});

// Side-effect free token status check. Never reveal the existing token value.
app.get("/api/me/livetoken", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  const userId = jwtPayload.userId;
  type HasTokenResult =
    | { ok: true; hasToken: boolean }
    | { ok: false; error: Error };
  const hasTokenResult: HasTokenResult = await db
    .hasLiveToken(c.env.LIVE_DB, userId)
    .then((hasToken): HasTokenResult => ({ ok: true, hasToken }))
    .catch((error: Error): HasTokenResult => ({ ok: false, error }));
  if (!hasTokenResult.ok) {
    logError(c.env, "live_token.status_check_failed", {
      ...createErrorLogFields(hasTokenResult.error),
      userId,
    });
    return c.text("Failed to check live token", 500);
  }

  return c.json({
    hasToken: hasTokenResult.hasToken,
  });
});

app.get("/api/lives", async (c) => {
  // Keep listing cheap: do not poll Calls for every live row here. Stale rows are
  // reconciled when a user tries to ingest or play the specific stream.
  const lives = await db.getAllLives(c.env.LIVE_DB);
  return c.json(lives);
});

export default app;
