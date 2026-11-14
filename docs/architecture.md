# Architecture Notes

This document records the operational decisions that are not obvious from the
code alone. The application is optimized for authenticated live viewing at
higher quality than Discord screen sharing, not for public WHEP
interoperability.

## Runtime Model

The Worker is treated as stateless request handling glue. Durable state that
must survive requests lives in one Durable Object, `LiveState`, while Cloudflare
Realtime SFU (formerly Cloudflare Calls, hence the `CALLS_*` secret names) owns
the actual media sessions and track state. Avoid designs that poll all active
sessions or keep long-lived in-memory state.

`LiveState` holds the broadcasts, publisher tokens, and users in its SQLite
storage. Routes reach it through the RPC methods of `getLiveState(env)` in
`worker/live-state.ts`. One object holds everything because `/api/lives` needs
every broadcast together with its owner's name, and the load is a handful of
short calls per viewer or publisher action. The class in `worker/main.ts` only
delegates to `LiveStateCore` in `worker/live-state.ts`, which the Node-based
tests run against Node's SQLite.

A Durable Object is billed for the wall-clock time it spends running or
awaiting, so `LiveState` must never call Realtime SFU, Discord, or any other
external API, and must not await anything except its own storage and alarm
calls. Each of its methods is synchronous SQL in one transaction. The Worker
makes the external calls between two of those methods and reports what it
observed. When the object itself has to start external work, it calls the
Worker's `LiveEffects` entrypoint through `ctx.exports`. That method returns at
once and does the work in `waitUntil`, so the object is finished within
milliseconds while the Worker waits for the external service.

The one scheduled task is ending a broadcast once its OBS reconnect grace period
passes (see Ingest Lifecycle). It is the object's alarm, which is set in the
same commit as the change that needs it, and only while a broadcast is waiting
for OBS or a notification delete is pending, so nothing runs otherwise. The
alarm is only a trigger: `lives.grace_expires_at` is authoritative, and every
`LiveState` method first ends the broadcasts whose deadline passed, so a late
alarm never lets a request see one.

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

## Storage Schema

The tables live in the `LiveState` object's SQLite storage and are defined by
`SCHEMA_MIGRATIONS` in `worker/database.ts`, which is the only description of
their shape. Each entry is one schema version. The object applies the versions
it has not recorded in `schema_migrations` when it starts, before it handles
any call, so deploying the Worker is what migrates the storage. Append a new
entry to change the schema; never edit one that has been deployed, because
objects that already applied it would not run it again.

The Vitest suite runs the same statements against Node's SQLite
(`worker/test-doubles.ts`), so a schema or query mistake fails `pnpm test`
instead of surfacing after a deploy. It cannot prove that a data-copying
migration moves or transforms existing rows correctly.

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
while viewers use the JWT cookie. Live tokens are shown only when created; the
live state stores an HMAC of the token with `LIVE_TOKEN_PEPPER`, not the raw
bearer token.

## Live Row Semantics

Each `lives` row represents one broadcast of its owner. `broadcast_id` stays the
same for the whole broadcast, while `session_id` and the stored `trackName` and
`mid` values point at the current SFU ingest session. Those are not
stable across OBS reconnects, so a reconnect replaces them in place instead of
reusing stale locators. `grace_expires_at` is `NULL` while that ingest session
is live and holds the reconnect deadline (Unix epoch milliseconds) after OBS
sent DELETE.

Each `LiveState` method runs alone and in one transaction, so transitions
never interleave inside the object. The Worker's Calls requests still happen
between two methods, though: it reads the row, asks Calls about the session,
and then asks the object to act on the answer. Those transitions are therefore
compare-and-set statements on the `session_id` and `grace_expires_at` the
Worker observed, so a delayed request never ends a broadcast that has since
resumed or entered a grace period. Resuming changes `session_id`, which is what
turns a stale end into a no-op.

The Worker does not try to keep the live list perfectly synchronized with the
SFU. Full synchronization would require polling every live session, which is too
expensive for `/api/lives` and does not fit the stateless Worker model. Instead,
the code performs targeted SFU checks when an operation already names a specific
user/session, such as ingest start or playback start.

## Ingest Lifecycle

`POST /ingest/:userId` is the authoritative live-start path:

- If the owner's broadcast is within its grace period, the new SFU session
  resumes it. The row's session and tracks are replaced, and no new start
  notification is sent.
- If the stored session is no longer active in the SFU (OBS crashed or lost its
  network without sending DELETE) but a request saw it active within the last
  60 seconds, OBS is reconnecting, so the new session resumes the broadcast the
  same way.
- If the stored session is no longer active and was not seen active recently,
  that broadcast is ended, with its row removed and its notification queued for
  deletion, and a new broadcast starts.
- If the grace period already passed, the live state ended the broadcast before
  the ingest could see it, so a new broadcast starts.
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
row and the start notification, and sets the live state's alarm for the
deadline. If no ingest resumed the broadcast by then, the live state removes
the row and has the Worker delete the notification (see Notifications). The
cost is that a deliberate stop removes the notification about a minute late. A
repeated DELETE for the same session is accepted without starting another grace
period.

OBS still sends DELETE when its window is closed; only crashes and network loss
skip it. Those are not polled for: the live state must not call the SFU, and
checking it throughout every broadcast would spend requests on a rare case.
They are detected when the next ingest or playback request for that owner finds
the stored session inactive, which Calls reports once it garbage-collects the
session about 30 seconds after losing it.

Without DELETE, the Worker cannot tell when the session was lost, so it cannot
tell an OBS reconnect from an ingest days later that is meant as a new
broadcast. To still resume a reconnect without a second notification, requests
that find the stored session active record when they did in
`session_seen_active_at`: an ingest rejected because the session is still
active, which is how a reconnecting OBS retries until Calls garbage-collects
the session, and a playback request, which viewers keep sending once media
stops. A session found inactive within 60 seconds of being seen active was lost
just now:

- An ingest resumes the broadcast without notifying.
- A playback request starts a 30-second grace period, as a late DELETE would,
  and answers 503. Together with the roughly 30 seconds Calls took to
  garbage-collect the session, the broadcast waits about as long as after a
  DELETE. Playback that loses the session between the activity check and the
  Calls request does the same, because it just saw the session active.

If nobody saw the session active shortly before it was garbage-collected, for
example when OBS comes back more than 30 seconds after losing its network and
nobody was watching, the next ingest starts a new broadcast with a new
notification. That is accepted so that a broadcast started much later is never
silently resumed without a notification.

The activity record is written at most every 10 seconds per session. The
Worker already holds the row it just read, so it skips the call to the live
state while the record is fresh; a viewer joining a healthy stream then costs
the object one call instead of two. The `UPDATE` repeats the check for requests
that raced each other. The record is best-effort; without it, a lost session
ends the broadcast as before.

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
retries against the new state. A session that was lost just now starts a short
grace period instead of ending the broadcast, as described under Ingest
Lifecycle. `/api/lives` keeps listing broadcasts in their grace period. One
whose deadline passed is never listed, even when the alarm is late, because the
live state ends overdue broadcasts before it answers any call.

Playback DELETE requests close only the track mids embedded in the WHEP session
URL returned by the Worker. The frontend must use that returned `Location`
instead of reconstructing a session URL from stored data. Session IDs are not
tied to the viewer, because only the viewer that created a playback session
learns its ID. The Worker does reject IDs with characters other than
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

The Worker answers 404 once the grace period has passed even if the alarm that
ends the broadcast is late, so the client normally learns the end from the
server. The
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
64-bit snowflakes that do not fit in a JavaScript `number`, so the id is stored,
and passed between the Worker and the live state, as decimal text.

Deleting the notification is the one external call the live state starts, and
it cannot make that call itself (see Runtime Model). Ending a broadcast
therefore moves its message id into the `notification_deletes` outbox in the
same transaction that removes the row. The alarm leases every due entry and
hands the batch to the Worker's `LiveEffects.deleteStartNotifications`, which
returns at once and deletes the messages in `waitUntil`. The Worker then
reports the finished deletes back (`settleNotificationDeletes`) and the object
drops them. A delete is finished when Discord deleted the message or when
trying again cannot succeed, such as for a message that was already deleted.

A delete that failed with a network error, timeout, 429, or 5xx is not
reported, so its lease expires and the alarm hands it out again. Leases start
at 30 seconds, which covers the time a Worker's `waitUntil` may run, and double
on every attempt. After six attempts, spread over about 15 minutes, the entry
is dropped with a `live_notification.delete_abandoned` warning and the message
stays in Discord. The outbox is at-least-once, so a message can be deleted
twice; Discord answers the second attempt with 404, which finishes it.

A broadcast that ends because a request found its session inactive queues its
delete the same way, due at once, so the alarm set by that same call hands it
out right away. If the notification id arrives after its broadcast ended, the
live state queues it for deletion instead of storing it. If the call that
stores the id fails, the Worker cannot know whether the id was stored, so it
deletes the message itself.

Notification send/delete failures are logged but do not block ingest or
playback cleanup.

## Deferred Work

Pushing live-state updates to clients is intentionally deferred; the client and
normal HTTP requests remain the triggers for reconciliation. Do not add SSE for
it. A Durable Object cannot hibernate while holding SSE connections, so
`LiveState` would be billed for as long as anyone has the page open. If
live-state push becomes necessary, revisit it with hibernatable WebSockets.
