# Project Overview

`wish-broad` is a livestreaming application built for Cloudflare Realtime SFU / Calls. It features an ingest endpoint for OBS using WHIP, and an authenticated playback flow inspired by WHEP. Viewers authenticate via Discord OAuth and are restricted based on Discord guild membership. The project is designed with a stateless Cloudflare Worker for its API backend, and uses Cloudflare D1 for durable database storage (like live stream details and token states). The frontend is a React application built with Vite.

The application is optimized for authenticated live viewing at higher quality than Discord screen sharing, not for public WHEP interoperability.

## Tech Stack
- **Frontend:** React 19, Vite, Tailwind CSS 4, SWR, Valibot. UI copy is Japanese and should consistently use that tone.
- **Backend / API:** Cloudflare Workers, Hono, neverthrow, Valibot.
- **Infrastructure:** Cloudflare D1 (Database), Cloudflare Realtime SFU / Calls (WebRTC), Cloudflare Vite Integration.
- **Language:** TypeScript across the entire stack.
- **Testing/Formatting:** Vitest, Prettier, ESLint, Knip.

## Data Model & Types

### D1 Schema (`schema.sql`)
- `lives`: Stores active live sessions. Primary key is `user_id` (one live row exists per owner). Tracks `session_id` and `tracks_json` (StoredTrack array for SFU session), and `notification_message_id`.
- `live_tokens`: Stores publisher tokens as HMAC hashes (`token_hash`), never raw bearer tokens. One token per `user_id`.
- `users`: Caches Discord user info (`user_id`, `display_name`).

### Shared Types (`worker/types.ts`, `src/types.ts`)
- **JWT:** `JWTPayload` contains `{ iat, exp, userId, displayName }`.
- **API Models:** 
  - `User`: `{ userId: string, displayName: string }`
  - `Live`: `{ owner: User }`

## Module Organization & Architecture

### Runtime Split & Routing
- Runtime split: Cloudflare Worker backend (`worker/`) plus React + Vite frontend (`src/`), bundled together via `@cloudflare/vite-plugin` and deployed with `wrangler.jsonc`.
- Worker HTTP routing is centralized in `worker/index.ts`:
  - `/login`, `/login/callback`, `/logout` for Discord OAuth.
  - `/ingest/:userId*` for WHIP ingest (publisher side).
  - `/play/:userId*` for WHEP playback (viewer side).
  - `/api/*` for authenticated app APIs (`/api/me`, `/api/lives`, `/api/me/livetoken`).
  - Keep frontend API calls relative (`/api/...`, `/play/...`, `/ingest/...`) so Worker + assets work in the same origin setup.

### Backend (`worker/`)
- The Worker is intentionally **stateless**. Durable state lives in D1, while Cloudflare Calls owns the media sessions.
- `worker/database.ts`: SQL access and data layer. Route handlers should call DB helpers here, not embed raw SQL.
- `worker/sfu.ts`: Cloudflare Calls/SFU integration. Route handlers orchestrate it rather than issuing direct SFU API requests.
- `worker/discord.ts` & `worker/discord-login.ts`: Discord OAuth helpers.
- `worker/notifications.ts`: Best-effort Discord live notifications.
- `worker/turn.ts`: TURN credential generation.
- Untrusted external payloads must be validated with Valibot schemas colocated in their consuming modules (e.g., `worker/sfu.ts`, `worker/discord.ts`, `worker/database.ts`) instead of trusting raw JSON.
- The Worker does not try to keep the D1 live list perfectly synchronized with the SFU to avoid polling costs. Stale session detection is shifted to specific operations (ingest start or playback start).

## End-to-End Workflows

### Authentication
- Discord auth spans `worker/discord-login.ts` + `worker/discord.ts`: OAuth state cookie handshake, code exchange, guild-membership verification, user upsert, JWT cookie (`authtoken`) issuance.
- **Viewer Auth Flow:** 
  - Frontend boot (`src/App.tsx`) gates on `useAuth()` (`/api/me`) to resolve `authenticated` / `unauthenticated` / `error`.
  - `/login` starts Discord OAuth; `/login/callback` verifies guild membership, upserts user, sets `authtoken` cookie.
  - `/api/*` and `/play/*` are protected by cookie JWT middleware (`jwt({ secret: c.env.JWT_SECRET, cookie: "authtoken", alg: "HS256" })` using `JWTPayload` from `worker/types.ts`).
- **Publish Auth:** OBS uses a bearer live token. Ingest auth is hash-based validation (`hashed-bearer-auth.ts` + `token-hash.ts`). Live tokens are shown only when created and stored in D1 as an HMAC hash using `LIVE_TOKEN_PEPPER`. Do not store or compare raw live tokens server-side.

### Publish Path (WHIP)
- OBS posts SDP offer to `/ingest/:userId` with bearer token.
- Worker checks for existing stream state in D1, validates/stale-cleans session, then calls `startIngest`.
- Returned track metadata is persisted to `live_tracks`; response is SDP answer plus `location` and `etag` headers. Preserve SDP body/content-type handling and these headers.
- **Cleanup:** `DELETE /ingest/:userId/:sessionId` closes tracks via SFU and then removes D1 rows.

### Playback Path (WHEP)
- `WHEPPlayer` composes UI state and delegates playback lifecycle to `WHEPVideoPlayer` + `WHEPSession` (`src/player/WHEPVideoPlayer.tsx`, `src/player/WHEPClient.ts`).
- Client sends local SDP offer to `POST /play/:userId`; server replies with SDP and `location`.
  - `201` means SDP answer (apply directly).
  - `406` means counter-offer (set remote offer, create local answer, `PATCH` to session URL).
- The WHEP client is custom and expects local ICE gathering to complete before POSTing the SDP offer. It fetches TURN credentials from `/api/turn-credentials` (filtering out ICE URLs on port 53).
- **Reconnect:** Reconnect behavior is centralized in `WHEPVideoPlayer` + `whep-reconnect.ts` (bounded retry window + backoff + resume triggers on visibility/pageshow/focus/online). WebRTC/reconnect changes must update setup + teardown + retry paths together to avoid stale sessions or leaked timers.
- **Cleanup:** Viewer startup removes stale D1 records when SFU reports a dead publish session. `WHEPSession.dispose()` tears down local WebRTC resources and sends `DELETE` to the server session URL.

### API Contracts
Preserve existing API contracts consumed by hooks/components:
- `GET /api/me` -> `{ userId, displayName }`
- `GET /api/me/livetoken` -> `{ hasToken }`
- `POST /api/me/livetoken` -> `{ success: true, token }`
- `GET /api/lives` -> `Live[]`

## Building, Running, and Validation

### Development Commands
- `pnpm install` - Install dependencies.
- `pnpm dev` - Vite client dev server.
- `pnpm dev:worker` - Worker-only local runtime (`wrangler dev --local`).
- `pnpm dev:full` - Integrated Wrangler dev flow.
- Note: Requires `.dev.vars` with secrets. Keep binding names aligned across `wrangler.jsonc`, `.dev.vars`, and `worker/types.ts`.

### Building & Deployment
- `pnpm build` - TypeScript compile + Vite build.
- `pnpm build:analyze` - Emits bundle analysis artifacts.
- `pnpm deploy` - Build and deploy the project via Wrangler to Cloudflare.
- `pnpm cf-typegen` - Generate TypeScript definitions for the Cloudflare bindings. Run this if you add/change bindings.

### Validation & Testing
- `pnpm check` - Type-check + ESLint + `pnpm check:unused-exports` via Knip.
- `pnpm format` - Apply Prettier defaults repo-wide.
- `pnpm format:check` - Run Prettier formatting verification.
- `pnpm schema:check` - Verify `schema.sql` matches D1 migrations.
- **Testing:** 
  - `pnpm test` - Run all Vitest suites.
  - `pnpm test:watch` - Vitest watch mode.
  - `pnpm exec vitest run worker/index.test.ts` - Run one Worker test file.
  - `pnpm exec vitest run src/player/whep-reconnect.test.ts` - Run one frontend test file.
  - `pnpm exec vitest run worker/index.test.ts -t "issues a live token"` - Run one test case.

## Security & Auth Notes
- **Logging:** Do not log raw OBS bearer tokens, JWTs, cookies, Discord OAuth codes, or Cloudflare secrets. Use `LOG_LEVEL` (`debug`, `info`, `warn`, `error`, `silent`) for structured application logs instead of duplicating access logs.