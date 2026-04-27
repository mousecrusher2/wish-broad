# wish-broad

Discord OAuthで視聴者を制限する、Cloudflare Workers + Cloudflare Realtime SFU向けの配信アプリです。

OBSはWHIPで配信し、認証済みユーザーはブラウザからアプリ専用の視聴フローで再生します。視聴側のSDP交換やセッション管理はWHEPを参考にしていますが、公開WHEPエンドポイント互換を目的にした実装ではありません。

## Features

- Discord guild membership based login
- Per-user OBS ingest URL and bearer live token
- WHIP ingest endpoint for OBS
- Authenticated playback flow inspired by WHEP
- Cloudflare Calls / Realtime SFU session management
- D1-backed live stream and token state
- Authenticated TURN credential endpoint
- Best-effort Discord live-start notifications

## Stack

- React 19
- Vite
- Hono
- Cloudflare Workers
- Cloudflare D1
- Cloudflare Realtime SFU / Calls
- SWR
- Valibot
- neverthrow
- Vitest

## Requirements

- Node.js and pnpm
- Cloudflare account with Workers, D1, and Realtime SFU/Calls access
- Discord application for OAuth
- Discord guild used as the viewer allowlist
- Discord webhook for live notifications
- `sqlite3` CLI if you run schema drift checks

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

Non-secret runtime variables are configured in `wrangler.jsonc`. Keep binding names aligned across `wrangler.jsonc`, `.dev.vars`, and `worker/types.ts`.

## Development

Run the Vite client:

```sh
pnpm dev
```

Run a local Worker session:

```sh
pnpm dev:worker
```

Run the integrated Cloudflare/Vite dev server:

```sh
pnpm dev:full
```

`pnpm dev` is useful for frontend iteration, but it does not exactly match the production Worker bundle. Use Wrangler-based flows when validating Worker behavior, auth, or WebRTC paths.

## Validation

Run the standard checks:

```sh
pnpm check
pnpm test
pnpm run format:check
pnpm build
```

After editing D1 migrations or `schema.sql`, run:

```sh
pnpm schema:check
```

`schema.sql` is the authoritative current schema. Migrations in `migrations/` are deployment history and should stay aligned with it. `pnpm schema:check` only verifies schema shape; it cannot prove that data migration logic preserves existing data correctly.

## Deployment

Build and deploy with Wrangler:

```sh
pnpm deploy
```

Production secrets must be configured in Cloudflare before deployment. The Worker expects the D1 binding named `LIVE_DB` and the required secrets listed above.

## Architecture Notes

The Worker is intentionally stateless. Durable state lives in D1, while media session state is owned by Cloudflare Realtime SFU. The app avoids designs that require Workers to run timers, poll all live sessions, or keep long-lived in-memory state.

Viewing is intentionally authenticated and app-specific. TURN discovery is provided through `/api/turn-credentials`, not generic WHEP `OPTIONS`/`Link` discovery. The playback client waits for local ICE gathering before POST/PATCH because the current SFU path is effectively non-trickle.

More details are documented in [docs/architecture.md](docs/architecture.md).

## Security Notes

- Do not log raw OBS bearer tokens, JWTs, cookies, Discord OAuth codes, or Cloudflare secrets.
- Live tokens are displayed only when created and are stored as HMAC hashes using `LIVE_TOKEN_PEPPER`.
- Viewer auth uses an app-issued JWT cookie after Discord guild membership is verified.
- This app is designed for restricted viewing, not for exposing a public WHEP-compatible endpoint.
