# Wish Broad Copilot Instructions

## Build, test, and lint commands

- `pnpm dev` - Vite client dev server.
- `pnpm dev:worker` - Worker-only local runtime (`wrangler dev --local`).
- `pnpm dev:full` - Integrated Wrangler dev flow.
- `pnpm build` - TypeScript compile + Vite build.
- `pnpm check` - Type-check + ESLint (repo lint gate).
- `pnpm test` - Run all Worker tests with Vitest.
- `pnpm test:watch` - Vitest watch mode.
- `pnpm exec vitest run worker/index.test.ts` - Run a single test file.
- `pnpm exec vitest run worker/index.test.ts -t "issues a live token for an authenticated user"` - Run one test case.

## High-level architecture

- Runtime split: Cloudflare Worker backend (`worker/`) plus React + Vite frontend (`src/`), bundled together via `@cloudflare/vite-plugin` (`vite.config.ts`) and deployed with `wrangler.jsonc`.
- Worker routing lives in `worker/index.ts`:
  - `/login`, `/login/callback`, `/logout` for Discord OAuth.
  - `/ingest/:userId*` for WHIP ingest (publisher side).
  - `/play/:userId*` for WHEP playback (viewer side).
  - `/api/*` for authenticated app APIs (`/api/me`, `/api/lives`, `/api/me/livetoken`).
- Auth flow spans `worker/discord-login.ts` and `worker/discord.ts`: OAuth code exchange, guild-membership check, D1 user upsert, JWT cookie (`authtoken`) issuance.
- Cloudflare Calls integration is centralized in `worker/calls.ts` (`startIngest`, `startPlay`, `renegotiateSession`, `closeTracks`).
- Data persistence uses D1 tables in `schema.sql` (`live_tracks`, `live_tokens`, `users`), accessed through `worker/database.ts`.
- External response validation and stored JSON parsing are handled by Valibot schemas in `worker/validation.ts`.
- End-to-end auth path:
  - UI hits `/api/me` (`useAuth`) to resolve `authenticated` vs `unauthenticated`.
  - `/login` starts Discord OAuth; `/login/callback` exchanges code, verifies guild membership, upserts user in D1, then sets `authtoken` cookie.
  - `/api/*` and `/play/*` are protected by cookie JWT middleware.
- End-to-end publish path (WHIP):
  - OBS posts SDP offer to `/ingest/:userId` with bearer token from `/api/me/livetoken`.
  - Worker checks for existing stream state in D1, validates/stale-cleans session, then calls `startIngest`.
  - Returned track metadata is persisted to `live_tracks`; response is SDP answer plus WHIP headers (`location`, `etag`, protocol headers).
- End-to-end playback path (WHEP):
  - `WHEPPlayer` (`useWebRTCLoad`) POSTs to `/play/:userId` to get SDP answer and session `location`.
  - Hook PATCHes session URL with local SDP answer and attaches remote tracks to `<video>`.
  - Reconnect/health behavior is coordinated by `useReconnection` + `usePageVisibility`; connection refs/state come from `useWebRTCConnection`.
- Session cleanup behavior:
  - `DELETE /ingest/:userId/:sessionId` closes tracks via Calls and then removes D1 rows.
  - Viewer startup also removes stale D1 records if Calls reports a dead session.
- Frontend flow:
  - `src/App.tsx` gates UI with `useAuth` (`/api/me`).
  - `src/WHEPPlayer.tsx` composes stream selection, playback controls, and OBS setup.
  - WebRTC logic is split into hooks: state/refs (`useWebRTCConnection`), negotiation/loading (`useWebRTCLoad`), reconnect/health-check orchestration (`useReconnection`), visibility awareness (`usePageVisibility`).
  - SWR hooks (`useLiveStreams`, `useLiveToken`) own `/api/lives` and `/api/me/livetoken` data state.

## Key conventions for this repository

- Keep Worker API calls relative from the frontend (`/api/...`, `/play/...`, `/ingest/...`) and include `credentials: "include"` on protected requests.
- Keep D1 SQL and table knowledge in `worker/database.ts`; route handlers should call DB helpers, not embed raw SQL.
- Keep Cloudflare Calls HTTP logic in `worker/calls.ts`; route handlers orchestrate it rather than issuing direct Calls API requests.
- Parse/validate external payloads through `worker/validation.ts` helpers instead of trusting raw JSON.
- Keep JWT behavior consistent: protected routes use `jwt({ secret: c.env.JWT_SECRET, cookie: "authtoken", alg: "HS256" })` and payload shape from `worker/types.ts::JWTPayload`.
- If you add/change Worker bindings, update `worker/types.ts::Bindings` and run `pnpm cf-typegen`.
- Preserve existing API contracts consumed by hooks/components:
  - `GET /api/me` -> `{ userId, displayName }`
  - `GET /api/me/livetoken` -> `{ hasToken }`
  - `POST /api/me/livetoken` -> `{ success: true, token }`
  - `GET /api/lives` -> `Live[]`
- For WHIP/WHEP signaling routes, preserve SDP response/body handling and protocol headers (`content-type`, `protocol-version`, `location`, `etag`).
- D1 schema source of truth is `schema.sql`; apply local schema changes with `wrangler d1 execute <binding> --file=schema.sql`.
- Frontend user-facing messages are Japanese; keep new UI copy aligned.
- WebRTC changes must update both setup and teardown paths (`cleanupConnection`, timeout cleanup, effect cleanup) to avoid stale peer connections or timers.
