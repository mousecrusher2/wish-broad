# wish-broad

Discord OAuthで視聴者を制限する、Cloudflare Workers + Cloudflare Realtime SFU向けの配信アプリです。

OBSはWHIPで配信し、認証済みユーザーはブラウザからアプリ専用の視聴フローで再生します。視聴側のSDP交換やセッション管理はWHEPを参考にしていますが、公開WHEPエンドポイント互換を目的にした実装ではありません。

## Features

- Discord guild membership based login
- Per-user OBS ingest URL and bearer live token
- WHIP ingest endpoint for OBS
- Authenticated playback flow inspired by WHEP
- Cloudflare Realtime SFU session management
- Durable Object-backed live stream and token state
- Authenticated TURN credential endpoint
- Best-effort Discord live-start notifications, skippable per stream with
  `?notify=false` on the ingest URL
- Broadcasts survive OBS reconnects for 60 seconds without re-notifying, and
  viewers keep waiting for the stream to come back

## Stack

- React 19 with React Compiler
- Vite with the Cloudflare Vite plugin
- Tailwind CSS v4
- Hono
- Cloudflare Workers
- Cloudflare Durable Objects (SQLite storage and alarms)
- Cloudflare Realtime SFU and TURN (formerly Calls)
- SWR
- Valibot
- Vitest
- oxlint, Knip, and Prettier

## Requirements

- Node.js and pnpm
- Cloudflare account with Workers, Durable Objects, Realtime SFU, and Realtime TURN access
- Discord application for OAuth
- Discord guild used as the viewer allowlist
- Discord webhook for live notifications

## Setup

Install dependencies:

```sh
pnpm install
```

Create local Worker variables in `.dev.vars`. Do not commit this file.

Required secrets:

```text
AUTHORIZED_GUILD_ID
CALLS_APP_ID
CALLS_APP_SECRET
DISCORD_CLIENT_ID
DISCORD_CLIENT_SECRET
JWT_SECRET
LIVE_TOKEN_PEPPER
NOTIFICATIONS_DISCORD_WEBHOOK_URL
TURN_KEY_API_TOKEN
TURN_KEY_ID
```

Non-secret runtime variables are configured in `wrangler.jsonc`. Keep binding names aligned between `wrangler.jsonc` and `.dev.vars`, and run `pnpm cf-typegen` after changing bindings to regenerate `worker-configuration.d.ts`.

## Development

Start the dev server:

```sh
pnpm dev
```

The Cloudflare Vite plugin runs the Worker in the local `workerd` runtime next to the client, so the API, ingest, and playback routes are served from the same origin during development.

Build and serve the production bundle locally:

```sh
pnpm preview
```

Use `pnpm preview` when validating behavior that depends on the production bundle.

## Validation

Run the standard checks:

```sh
pnpm check
pnpm test
pnpm run format:check
pnpm build
```

## Deployment

Build and deploy with Wrangler:

```sh
pnpm deploy
```

Production secrets must be configured in Cloudflare before deployment. The `LIVE_STATE` Durable Object binding and its storage are created by `wrangler deploy` from `wrangler.jsonc`, and the object creates its own tables when it starts, so there is no database to create or migrate by hand.

Deploying this version over one that still keeps its state in D1 drops that state: the Durable Object starts empty and the D1 rows are not imported. Read [Cutover from D1](docs/architecture.md#cutover-from-d1) before doing so; publishers have to create new live tokens afterwards.

## Architecture Notes

The Worker is intentionally stateless. Durable state lives in the SQLite storage of one Durable Object (`LiveState`), while media session state is owned by Cloudflare Realtime SFU. The object only runs short transactions on its own storage: it never calls Realtime SFU, Discord, or any other external API, because it is billed for the time it spends waiting. The app avoids designs that poll all live sessions or keep long-lived in-memory state. The one scheduled task is the object's alarm, which ends a broadcast once its 60-second OBS reconnect grace period passes and hands the Discord cleanup to the Worker; it is only set while a broadcast is waiting for OBS or a notification is waiting to be deleted.

Viewing is intentionally authenticated and app-specific. TURN discovery is provided through `/api/turn-credentials`, not generic WHEP `OPTIONS`/`Link` discovery. The playback client waits for local ICE gathering before POST/PATCH because the current SFU path is effectively non-trickle.

More details are documented in [docs/architecture.md](docs/architecture.md).

## Security Notes

- Do not log raw OBS bearer tokens, JWTs, cookies, Discord OAuth codes, or Cloudflare secrets.
- Live tokens are displayed only when created and are stored as HMAC hashes using `LIVE_TOKEN_PEPPER`.
- Viewer auth uses an app-issued JWT cookie after Discord guild membership is verified.
- This app is designed for restricted viewing, not for exposing a public WHEP-compatible endpoint.
