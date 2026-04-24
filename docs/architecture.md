# Architecture Notes

This document records the operational decisions that are not obvious from the
code alone. The application is optimized for authenticated live viewing at
higher quality than Discord screen sharing, not for public WHEP
interoperability.

## Runtime Model

The Worker is treated as stateless request handling glue. Durable state that
must survive requests lives in D1, while Cloudflare Calls owns the actual media
sessions and track state. Avoid designs that require the Worker to run timers,
poll all active sessions, or keep long-lived in-memory state.

Durable Objects and WebSocket notifications are intentionally deferred. A future
DO migration could centralize live state and per-room notifications, but until
then the client and normal HTTP requests are the practical triggers for
reconciliation.

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

Publish credentials are separate from viewer auth. OBS uses a bearer live token,
while viewers use the JWT cookie. Live tokens are shown only when created; D1
stores an HMAC of the token with `LIVE_TOKEN_PEPPER`, not the raw bearer token.

## Live Row Semantics

Each `lives` row is a pointer to a specific Cloudflare Calls ingest session and
its remote tracks. The stored `session_id`, `trackName`, and `mid` values are not
stable across OBS reconnects. When a live session ends or is replaced, the row
should be removed or replaced instead of retained as a pending state.

The Worker does not try to keep the D1 live list perfectly synchronized with the
SFU. Full synchronization would require polling every live session, which is too
expensive for `/api/lives` and does not fit the stateless Worker model. Instead,
the code performs targeted SFU checks when an operation already names a specific
user/session, such as ingest start or playback start.

## Ingest Lifecycle

`POST /ingest/:userId` is the authoritative live-start path. If a stale row
exists, the Worker checks only that user's stored SFU session. Active sessions
reject a second ingest; inactive sessions are removed before inserting the new
session.

`DELETE /ingest/:userId/:sessionId` immediately removes the row for the matching
session and schedules SFU track cleanup. This can make Discord notification
deletion best-effort around OBS reconnects, because OBS may send DELETE while it
is about to create a fresh ingest session. The tradeoff is deliberate: retaining
invalid track locators would make playback and later cleanup less reliable.

## Playback Lifecycle

`POST /play/:userId` is authenticated with the viewer's JWT cookie and checks the
named live session before creating a playback session. This keeps `/api/lives`
cheap and shifts stale-session detection to the operation that actually needs
the session.

Playback DELETE requests close only the track mids embedded in the WHEP session
URL returned by the Worker. The frontend must use that returned `Location`
instead of reconstructing a session URL from D1 data.

The frontend also waits for an in-flight WHEP registration to resolve during
cleanup. A viewer can disconnect while `POST /play/:userId` is still in flight;
if Calls creates the session before the abort is observed, the returned
`Location` is still needed so the client can DELETE the playback session.

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

## Frontend Recovery

The React player owns a `WHEPPlaybackController` instance and explicitly remounts
it when the user loads a stream, even if the selected owner is unchanged. This
forces a fresh WHEP session for manual reloads.

Playback recovery is viewer-driven and bounded. The frontend reconnects when the
specific session loses expected tracks, stalls, or disconnects, but it gives up
within a fixed window so ended streams do not appear to load forever.

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

Discord live-start notifications are best-effort. The Worker asks Discord to
return the created message id so the message can be deleted when the matching
live row is removed. Notification send/delete failures are logged but do not
block ingest or playback cleanup.

## Deferred Work

Do not add SSE for live state updates. Durable Objects cannot hibernate while
holding SSE connections, and the current design avoids long-lived server state.
If live-state push becomes necessary, revisit it together with a DO/WebSocket
state model.
