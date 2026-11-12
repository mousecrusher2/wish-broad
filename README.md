# wish-broad

Discord OAuthで視聴者を制限する、Cloudflare Workers + Cloudflare Realtime SFU向けの配信アプリです。

OBSはWHIPで配信し、認証済みユーザーはブラウザからアプリ専用の視聴フローで再生します。視聴側のSDP交換やセッション管理はWHEPを参考にしていますが、公開WHEPエンドポイント互換を目的にした実装ではありません。

## Features

- Discord guild membership based login
- Per-user OBS ingest URL and bearer live token
- WHIP ingest endpoint for OBS
- Authenticated playback flow inspired by WHEP
- Cloudflare Realtime SFU session management
- D1-backed live stream and token state
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
- Cloudflare D1
- Cloudflare Workflows
- Cloudflare Realtime SFU and TURN (formerly Calls)
- SWR
- Valibot
- neverthrow
- Vitest
- oxlint, Knip, and Prettier

## Requirements

- Node.js and pnpm
- Cloudflare account with Workers, D1, Workflows, Realtime SFU, and Realtime TURN access
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

Production secrets must be configured in Cloudflare before deployment. The Worker expects the D1 binding named `LIVE_DB` and the required secrets listed above. Apply pending D1 migrations before deploying code that depends on them. The `LIVE_END_WORKFLOW` Workflow binding is created by `wrangler deploy` from `wrangler.jsonc`.

## Architecture Notes

The Worker is intentionally stateless. Durable state lives in D1, while media session state is owned by Cloudflare Realtime SFU. The app avoids designs that require Workers to run timers, poll all live sessions, or keep long-lived in-memory state. The one scheduled task is a Cloudflare Workflow that ends a broadcast once its 60-second OBS reconnect grace period passes; it only runs while a broadcast is waiting for OBS.

Viewing is intentionally authenticated and app-specific. TURN discovery is provided through `/api/turn-credentials`, not generic WHEP `OPTIONS`/`Link` discovery. The playback client waits for local ICE gathering before POST/PATCH because the current SFU path is effectively non-trickle.

More details are documented in [docs/architecture.md](docs/architecture.md).

## Security Notes

- Do not log raw OBS bearer tokens, JWTs, cookies, Discord OAuth codes, or Cloudflare secrets.
- Live tokens are displayed only when created and are stored as HMAC hashes using `LIVE_TOKEN_PEPPER`.
- Viewer auth uses an app-issued JWT cookie after Discord guild membership is verified.
- This app is designed for restricted viewing, not for exposing a public WHEP-compatible endpoint.
