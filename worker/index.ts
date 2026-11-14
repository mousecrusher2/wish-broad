import type { Context } from "hono";
import { HonoBase } from "hono/hono-base";
import { LinearRouter } from "hono/router/linear-router";
import { JWTPayload, Bindings } from "./types";
import type { LiveRecord } from "./database";
import {
  clearAuthCookie,
  completeDiscordLogin,
  startDiscordLogin,
} from "./discord-login";
import {
  type IngestSession,
  type PlaybackSession,
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
import {
  generateTurnIceServers,
  TurnApiError,
  type TurnIceServer,
} from "./turn";
import { createErrorLogFields, logError, logInfo, logWarn } from "./logger";
import { LIVE_RECONNECT_GRACE_MS } from "./live-end";
import { getLiveState } from "./live-state";

type AppEnv = {
  Bindings: Bindings;
  Variables: {
    jwtPayload: JWTPayload;
  };
};

// Matches the player's fixed reconnect interval.
const LIVE_RECONNECTING_RETRY_AFTER_SECONDS = 2;

// OBS can lose its ingest session without sending DELETE (a crash or network
// loss), and Calls garbage-collects the session about 30 seconds later.
// Requests that find the session active record when they did, at most this
// often, so a later request that finds it garbage-collected can tell whether
// the publisher was lost just now or long ago.
const LIVE_SESSION_SEEN_ACTIVE_WRITE_INTERVAL_MS = 10_000;
// A session garbage-collected within this long of last being seen active was
// lost just now. It matches the grace period after DELETE and covers OBS's
// growing reconnect interval plus the write interval above.
const LIVE_SESSION_RECENTLY_ACTIVE_MS = 60_000;
// Calls already waited about 30 seconds before garbage-collecting the session,
// so this keeps the broadcast about as long as the grace period after DELETE.
const LIVE_LOST_SESSION_GRACE_MS = 30_000;

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

// Calls session ids are opaque URL-safe tokens. The WHEP session routes embed
// the decoded path parameter in a Calls API URL, so reject anything else, such
// as a decoded "/" or "?", instead of letting it rewrite that URL.
function isCallsSessionId(sessionId: string): boolean {
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

function scheduleTrackClose(
  c: Context<AppEnv>,
  sessionId: string,
  tracks: StoredTrack[],
  failureLabel: string,
  errorLabel: string,
): void {
  // Track close is cleanup only. The live row is already updated before this
  // runs, so a transient Calls failure should not keep invalid track locators
  // visible.
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

// Runs in waitUntil after the ingest response, so every failure is logged here
// instead of being thrown.
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

  // Notifications are tied to the broadcast, which survives OBS reconnects. If
  // it has already ended, the live state queues the Discord message for
  // deletion itself instead of leaving an orphan.
  try {
    await getLiveState(c.env).setLiveNotificationMessageId(
      userId,
      broadcastId,
      messageId.toString(),
    );
    return;
  } catch (error: unknown) {
    logWarn(c.env, "live_notification.persist_failed", {
      ...createErrorLogFields(error),
      messageId: messageId.toString(),
      sessionId,
      userId,
    });
  }

  // Whether the id was stored is unknown, so nothing may ever delete the
  // message. Delete it now; a later delete of a stored id finds it gone.
  try {
    await deleteLiveStartedNotification(c.env, messageId);
  } catch (error: unknown) {
    logWarn(c.env, "live_notification.orphan_delete_failed", {
      ...createErrorLogFields(error),
      messageId: messageId.toString(),
      sessionId,
      userId,
    });
  }
}

function wasSessionSeenActiveRecently(live: LiveRecord, now: number): boolean {
  return (
    live.sessionSeenActiveAt !== null &&
    now - live.sessionSeenActiveAt <= LIVE_SESSION_RECENTLY_ACTIVE_MS
  );
}

// Best-effort: without the record, losing this session later without DELETE
// ends the broadcast at once instead of waiting for OBS to resume it.
function recordLiveSessionSeenActive(
  c: Context<AppEnv>,
  live: LiveRecord,
  now: number,
): void {
  // Viewers joining a healthy stream mostly find a fresh record. Skipping the
  // call here, not only the write, keeps them from waking the live state.
  if (
    live.sessionSeenActiveAt !== null &&
    now - live.sessionSeenActiveAt < LIVE_SESSION_SEEN_ACTIVE_WRITE_INTERVAL_MS
  ) {
    return;
  }

  c.executionCtx.waitUntil(
    getLiveState(c.env)
      .markLiveSessionSeenActive(
        live.userId,
        live.sessionId,
        LIVE_SESSION_SEEN_ACTIVE_WRITE_INTERVAL_MS,
      )
      .catch((error: unknown) => {
        logWarn(c.env, "live.session_activity_record_failed", {
          ...createErrorLogFields(error),
          sessionId: live.sessionId,
          userId: live.userId,
        });
      }),
  );
}

// Calls garbage-collected the ingest session shortly after a request saw it
// active, so OBS lost it just now without sending DELETE. Treat this like a
// late DELETE: keep the broadcast and its notification for a short grace
// period so that a reconnecting OBS resumes it instead of notifying again.
async function startLostSessionGrace(
  c: Context<AppEnv>,
  live: LiveRecord,
): Promise<void> {
  // If the row changed meanwhile (OBS sent DELETE or resumed), its new state
  // already decides what happens next.
  const graceExpiresAt = await getLiveState(c.env).startLiveReconnectGrace(
    live.userId,
    live.sessionId,
    LIVE_LOST_SESSION_GRACE_MS,
  );
  if (graceExpiresAt === null) {
    return;
  }

  logInfo(c.env, "live.session_lost", {
    graceExpiresAt,
    sessionId: live.sessionId,
    userId: live.userId,
  });
}

function respondLiveReconnecting(c: Context<AppEnv>): Response {
  // 503 tells viewers to keep retrying; 404 is reserved for an ended broadcast.
  return c.text("Live stream is waiting for the publisher to reconnect", 503, {
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

// OBS ingest authenticates with the per-user live token, not the viewer JWT.
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

// WHIP ingest start. A new ingest either resumes the owner's broadcast while it
// waits for OBS to reconnect, or starts a new broadcast with a notification.
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
  const now = Date.now();
  // A broadcast whose grace period passed is already ended by the live state,
  // so a stored grace deadline always means OBS may still resume.
  const existingLive = await liveState.getLive(userId);
  if (existingLive && existingLive.graceExpiresAt !== null) {
    resumableLive = existingLive;
  } else if (existingLive) {
    // Avoid global SFU sweeps in Workers. Only check the one row that blocks
    // this ingest attempt, which matters once Calls garbage-collected the
    // underlying session (OBS crashed or lost its network without DELETE).
    let isActive: boolean;
    try {
      isActive = await isSessionActive(c.env, existingLive.sessionId);
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

    if (isActive) {
      // This may be OBS retrying after losing the session without DELETE.
      // Remember that Calls still had it, so that the retry after Calls
      // garbage-collects it resumes the broadcast.
      recordLiveSessionSeenActive(c, existingLive, now);
      return c.text("A live stream is already active for this user", 400);
    }

    if (wasSessionSeenActiveRecently(existingLive, now)) {
      // The session was lost just now, so this is OBS reconnecting.
      resumableLive = existingLive;
    } else {
      // The session may have been lost long ago, for example days before an
      // ingest that is meant as a new broadcast, so start one and notify. If
      // the row changed meanwhile, the insert below rejects this ingest.
      await liveState.endLive(userId, existingLive.sessionId);
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

  // The live row points at this exact Calls session and track set. OBS
  // reconnects create new SDP, sessions, and mids, so a resume replaces them
  // while keeping the broadcast and its start notification.
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

  // Either there was nothing to resume, or the broadcast ended while this
  // session was negotiated; start a new broadcast.
  const broadcastId = await liveState.insertLive(
    userId,
    result.sessionId,
    result.tracks,
  );
  if (broadcastId === null) {
    // A concurrent ingest for this owner created or resumed the row after it
    // was read above, so that ingest owns the broadcast and its notification.
    // Nobody connects to this ingest's Calls session; Calls cleans it up.
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

// WHIP ingest end. Only the currently stored session can end its ingest.
app.get("/ingest/:userId/:sessionId", async () => {
  return new Response(null, { status: 204 });
});

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
    // A repeated DELETE for an ingest that already ended.
    return c.text("OK", 200);
  }

  if (
    existingLive.tracks.length === 0 ||
    existingLive.tracks.some((track) => track.mid.length === 0)
  ) {
    return c.text("Stored live track data is invalid", 500);
  }

  // OBS also sends DELETE right before it reconnects, which cannot be told
  // apart from stopping the stream. Keep the broadcast and its notification
  // for a grace period; the live state ends it unless a new ingest resumes it.
  const graceExpiresAt = await liveState.startLiveReconnectGrace(
    userId,
    sessionId,
    LIVE_RECONNECT_GRACE_MS,
  );
  if (graceExpiresAt === null) {
    return c.text("Failed to delete the requested live stream", 400);
  }

  // The stored track locators are invalid once this ingest session ended.
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

// Viewing is restricted to authenticated app users.
app.use("/play/*", csrf());
app.use("/play/*", async (c, next) => {
  const middleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  });
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Hono's jwt middleware erases the concrete app context type.
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

  const now = Date.now();
  const liveState = getLiveState(c.env);
  const liveTrackRecord = await liveState.getLive(userId);
  const tracks = liveTrackRecord?.tracks ?? [];
  if (liveTrackRecord && liveTrackRecord.graceExpiresAt !== null) {
    // The stored tracks were closed when OBS sent DELETE. Viewers retry until
    // OBS resumes the broadcast or the grace period ends it, after which the
    // live state no longer returns a row.
    return respondLiveReconnecting(c);
  }
  if (liveTrackRecord) {
    // Playback names one live owner, so this is the cheapest safe point to
    // reconcile stale live state with Calls without scanning every live row.
    let isActive: boolean;
    try {
      isActive = await isSessionActive(c.env, liveTrackRecord.sessionId);
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
    if (!isActive) {
      if (wasSessionSeenActiveRecently(liveTrackRecord, now)) {
        await startLostSessionGrace(c, liveTrackRecord);
        return respondLiveReconnecting(c);
      }
      // If the row changed meanwhile (OBS sent DELETE or resumed), let the
      // viewer retry against the new state instead of reporting an end.
      return (await liveState.endLive(userId, liveTrackRecord.sessionId))
        ? c.text(`Live stream not found: ${userId}`, 404)
        : respondLiveReconnecting(c);
    }
    // Viewers keep requesting playback while a lost publisher's session is
    // still waiting to be garbage-collected, so they notice the loss too.
    recordLiveSessionSeenActive(c, liveTrackRecord, now);
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
        // The ingest session was active when checked above, so Calls
        // garbage-collected it just now.
        await startLostSessionGrace(c, liveTrackRecord);
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
    if (!isCallsSessionId(sessionId)) {
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
  }) // This PATCH submits the answer to a 406 counter-offer, not trickle ICE.
  .patch(async (c) => {
    const { sessionId } = c.req.param();
    if (!isCallsSessionId(sessionId)) {
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

// All /api routes are browser APIs that require the app JWT cookie.
app.use("/api/*", csrf());
app.use("/api/*", async (c, next) => {
  const middleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  });
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Hono's jwt middleware erases the concrete app context type.
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

// Live tokens can be rotated at any time. Return the raw token only on creation;
// only the peppered HMAC is stored.
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

// Side-effect free token status check. Never reveal the existing token value.
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
  // Keep listing cheap: do not poll Calls for every live row here. Stale rows are
  // reconciled when a user tries to ingest or play the specific stream.
  const lives = await getLiveState(c.env).getAllLives();
  return c.json(lives);
});

export default app;
