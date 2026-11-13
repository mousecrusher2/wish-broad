# Architecture Notes

This document records the operational decisions that are not obvious from the
code alone. The application is optimized for authenticated live viewing at
higher quality than Discord screen sharing, not for public WHEP
interoperability.

## Runtime Model

The Worker is treated as stateless request handling glue. Durable state that
must survive requests lives in D1, while Cloudflare Realtime SFU (formerly
Cloudflare Calls, hence the `CALLS_*` secret names) owns the actual media
sessions and track state. Avoid designs that require the Worker to run timers,
poll all active sessions, or keep long-lived in-memory state.

The one scheduled task is ending a broadcast once its OBS reconnect grace period
passes (see Ingest Lifecycle). It runs as a Cloudflare Workflow instance
(`LiveEndWorkflow`, exported from `worker/main.ts`) that sleeps until the
deadline stored in D1, so nothing runs while no broadcast is waiting for OBS.
The Workflow is only a trigger: `lives.grace_expires_at` is authoritative, and
every request path treats a passed deadline as an ended broadcast, so a missed
or failed Workflow only delays notification cleanup. A Durable Object alarm
could replace it later without changing the row transitions; only
`scheduleLiveEnd` and the Workflow body in `worker/live-end.ts` would move.

Durable Objects and WebSocket notifications are intentionally deferred. A future
DO migration could centralize live state and per-room notifications, but until
then the client and normal HTTP requests are the practical triggers for
reconciliation.

## Logging

Cloudflare Workers invocation logs already provide request-level metadata such
as method, URL, status, and duration. The application logger therefore emits
structured event logs instead of duplicating access logs. Authenticated
`/api/*`, `/play/*`, and `/ingest/*` requests log one `info` event with the
available user/session identifiers; request correlation is left to Workers Logs.

`LOG_LEVEL` controls application log verbosity (`debug`, `info`, `warn`,
`error`, or `silent`). Production defaults to `info` when the variable is absent.
Warnings and errors include normalized error metadata, but raw bearer tokens,
JWTs, authorization codes, cookies, and secrets must never be logged.

## Schema Source

Treat `schema.sql` as the authoritative current D1 schema. Migration files are
the deployment history and should be updated alongside `schema.sql`, but code and
local reasoning should use `schema.sql` as the source of truth for current table
shape.

Use `pnpm schema:check` to replay migrations into a temporary SQLite database and
compare the resulting schema shape with `schema.sql`. The script requires the
`sqlite3` CLI on `PATH`. This is a drift mitigation for migration authoring only.
It cannot prove that data-copying migrations move or transform existing rows
correctly.

## Auth and Tokens

Discord OAuth is an admission check, not the long-lived app session. The Worker
uses the Discord access token only to verify membership in the configured guild,
then revokes it and issues its own `authtoken` JWT cookie.

The authorization request asks only for `guilds.members.read`. The membership
check calls `GET /users/@me/guilds/{guild.id}/member`, whose guild member
response already carries the user ID, username, global name, and nickname used
for the app session, so `identify` (`/users/@me`) is not requested.

The frontend does not gate initial rendering on a dedicated authentication
check. The API module starts one-shot SWR preloads for the current user, live
list, and live-token status, and the app bootstrap component subscribes to those
same three SWR keys. Any successful data result moves the app out of the initial
loading screen, while any 401 response is stored as an `UnauthorizedError`
result on its data key and moves it to the login screen. Individual data panels
read the same keys and keep their own loading/error states, so the normal app
shell can appear before every preload has finished without issuing duplicate
requests.

Publish credentials are separate from viewer auth. OBS uses a bearer live token,
while viewers use the JWT cookie. Live tokens are shown only when created; D1
stores an HMAC of the token with `LIVE_TOKEN_PEPPER`, not the raw bearer token.

## Live Row Semantics

Each `lives` row represents one broadcast of its owner. `broadcast_id` stays the
same for the whole broadcast, while `session_id` and the stored `trackName` and
`mid` values point at the current SFU ingest session. Those are not
stable across OBS reconnects, so a reconnect replaces them in place instead of
reusing stale locators. `grace_expires_at` is `NULL` while that ingest session
is live and holds the reconnect deadline (Unix epoch milliseconds) after OBS
sent DELETE.

Row transitions are compare-and-set statements on the observed `session_id`
and `grace_expires_at` rather than read-modify-write sequences. D1 offers no
per-row lock, and a delayed request or Workflow must never end a broadcast that
has since resumed or entered a new grace period. Resuming changes `session_id`,
which is what turns an already scheduled end into a no-op.

The Worker does not try to keep the D1 live list perfectly synchronized with the
SFU. Full synchronization would require polling every live session, which is too
expensive for `/api/lives` and does not fit the stateless Worker model. Instead,
the code performs targeted SFU checks when an operation already names a specific
user/session, such as ingest start or playback start.

## Ingest Lifecycle

`POST /ingest/:userId` is the authoritative live-start path:

- If the owner's broadcast is within its grace period, the new SFU session
  resumes it. The row's session and tracks are replaced, and no new start
  notification is sent.
- If the grace period already passed, or the stored session is no longer active
  in the SFU (OBS crashed without sending DELETE), that broadcast is ended, with
  its row and notification removed, and a new broadcast starts.
- If the stored session is still active, the second ingest is rejected. Only
  that user's stored SFU session is checked.
- If a concurrent ingest for the same owner created or resumed the row while
  this one was negotiated, this one is rejected the same way instead of
  failing on the primary key. Only the ingest that owns the row notifies, and
  the rejected ingest's Calls session is left for Calls to clean up.

`DELETE /ingest/:userId/:sessionId` cannot tell an intentional stop from a
reconnect, because OBS sends DELETE before every reconnect, including the
frequent ones caused by unstable WHIP connections. Removing the broadcast here
would delete and re-post the Discord notification on every reconnect, so DELETE
starts a 60-second grace period instead. It closes the ingest tracks, keeps the
row and the start notification, and schedules the live-end Workflow for the
deadline. If no ingest resumed the broadcast by then, the Workflow removes the
row and deletes the notification. The cost is that a deliberate stop removes
the notification about a minute late. A repeated DELETE for the same session is
accepted without starting another grace period.

OBS still sends DELETE when its window is closed; only crashes and network loss
skip it. Those are not polled for, because checking the SFU throughout every
broadcast would spend Workflow steps or requests on a rare case. They are
detected when the next ingest or playback request for that owner finds the
stored session inactive.

## Playback Lifecycle

`POST /play/:userId` is authenticated with the viewer's JWT cookie and checks the
named live session before creating a playback session. This keeps `/api/lives`
cheap and shifts stale-session detection to the operation that actually needs
the session.

While the broadcast is in its grace period, `POST /play/:userId` returns 503
with `Retry-After` without calling the SFU, because the stored tracks were closed
by DELETE. A 404 therefore means the broadcast has ended. If a playback request
finds the stored session inactive but cannot end the row because it changed in
the meantime (OBS sent DELETE or resumed), it also answers 503 so the viewer
retries against the new state. `/api/lives` keeps listing broadcasts in their
grace period and hides ones whose deadline passed, even before the Workflow
removed them.

Playback DELETE requests close only the track mids embedded in the WHEP session
URL returned by the Worker. The frontend must use that returned `Location`
instead of reconstructing a session URL from D1 data. Session IDs are not tied
to the viewer, because only the viewer that created a playback session learns
its ID. The Worker does reject IDs with characters other than
`[0-9A-Za-z_-]` on playback DELETE and PATCH, because it embeds the decoded ID
in a Calls API URL.

Playback DELETE is best-effort. If a viewer disconnects while
`POST /play/:userId` is still in flight, the client aborts the request and
DELETEs nothing, even if the Worker already created a Calls playback session.
Nobody connects to that session, so it carries no media until Calls cleans it
up.

## WHEP Client Decisions

The frontend WHEP client is not a generic WHEP client. It connects to this
Worker's `/play/:userId` endpoint so viewer access can remain cookie/JWT
protected.

The client waits for local ICE gathering before POSTing the SDP offer. This
trades some setup latency for reliability because the current SFU path is
effectively non-trickle. WHEP trickle ICE is optional, and the Worker PATCH route
is reserved for the 406 counter-offer answer flow rather than
`application/trickle-ice-sdpfrag`.

TURN credentials are fetched from `/api/turn-credentials` before offer creation.
This is an application-specific authenticated endpoint rather than a generic
WHEP `OPTIONS`/`Link` implementation.

The TURN response filters out ICE URLs on port 53. Cloudflare returns both
primary and alternate ports, but their Realtime SFU docs note that browsers are
known to block the alternate port 53. With trickle ICE this would only waste one
candidate; this app waits for complete ICE gathering before POST/PATCH, so
filtering port 53 avoids waiting for a browser-side timeout.

The custom `Wish-Live-Track-Count` response header tells the frontend how many
stored live tracks it should expect. If playback negotiates fewer tracks than
the ingest stored, the client treats that as an incomplete session and reconnects
instead of accepting a degraded connection as healthy.

The client registers mute, unmute, and ended listeners when the PeerConnection
delivers a remote track. Calling `MediaStream.addTrack()` does not emit `addtrack`,
so the client also refreshes playable stream state directly in the track handler.

## Frontend Recovery

The React player owns a `WHEPPlaybackController` instance and explicitly remounts
it when the user loads a stream, even if the selected owner is unchanged. This
forces a fresh WHEP session for manual reloads.

Playback recovery is viewer-driven and bounded. The frontend reconnects when the
specific session loses expected tracks, stalls, or disconnects. The client
treats the play endpoint's status as the source of truth for whether to keep
waiting: a 503 means the broadcast still exists without a usable session, so
the client keeps retrying every 2 seconds (the `Retry-After` the Worker sends),
even on an initial load; a 404 means the broadcast has ended, so playback ends
at once. Because the server decides, retries use a fixed interval instead of
backing off.

The Worker answers 404 once the grace period has passed even if the scheduled
end never ran, so the client normally learns the end from the server. The
client still gives up after a fixed window (75 seconds) as a safety net, so a
server that keeps failing or answering 503 is not polled forever. The window
must outlast the Worker's 60-second publisher reconnect grace period, because
the viewer usually notices the stall a few seconds after OBS sent DELETE. Other 5xx responses and network
errors fail the initial attempt, so a broken server still surfaces as an error
on the initial load. They are retried only once the client is already
reconnecting, whether after an established session dropped or while waiting out
503 responses. If the window expires while the server keeps answering 503, playback ends with an error rather than "ended",
because the Worker never confirmed that the broadcast was over.

The stall check uses inbound `bytesReceived` per receiver as the required
end-of-stream detector for the common publish-stop path. When a publisher ends a
stream, the viewer commonly sees exactly this state: SFU session existence, ICE
connection state, and negotiated track count can remain apparently healthy while
RTP stops arriving. `bytesReceived` is the browser-side proof that media is still
flowing for each expected track, so this is the primary path that turns a stopped
stream into reconnect/end handling. The monitor runs only while the document is
visible to avoid background throttling noise, and reconnects after a short stall
because this app assumes a stable network suitable for higher-quality viewing.

Track discovery has a separate timeout because `bytesReceived` can only be
checked after every expected inbound RTP receiver appears in browser stats. If
the Worker said the live has two stored tracks but the PeerConnection exposes
only one receiver, the playback session is incomplete even if ICE is connected;
the client must replace that session rather than accepting partial playback.

## Notifications

A start notification is sent when `POST /ingest/:userId` starts a new
broadcast, unless the ingest URL carries `notify=false` or `notify=0`. Resuming
a broadcast never sends one.

Discord live-start notifications are best-effort. The Worker asks Discord to
return the created message id so the message can be deleted when the broadcast
ends. The id is stored by `broadcast_id`, not by ingest session, so a reconnect
while the notification is still being sent does not orphan it. Message ids are
64-bit snowflakes; D1 cannot bind JavaScript `bigint` values and would read an
`INTEGER` back as a lossy `number`, so the id is stored as decimal text.

Notification send/delete failures are logged but do not block ingest or
playback cleanup. The live-end Workflow lets Workflows retry a delete that
failed with a network error, timeout, 429, or 5xx; other failures, such as a
message that was already deleted, are logged once.

## Deferred Work

Do not add SSE for live state updates. Durable Objects cannot hibernate while
holding SSE connections, and the current design avoids long-lived server state.
If live-state push becomes necessary, revisit it together with a DO/WebSocket
state model.
