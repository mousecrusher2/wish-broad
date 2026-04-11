# Wish Broad Copilot Instructions

## Build, test, and lint commands

- `pnpm dev` - Vite client dev server.
- `pnpm dev:worker` - Worker-only local runtime (`wrangler dev --local`).
- `pnpm dev:full` - Integrated Wrangler dev flow.
- `pnpm build` - TypeScript compile + Vite build.
- `pnpm check` - Type-check + ESLint.
- `pnpm test` - Run all Vitest suites (`worker/**/*.test.ts`, `src/**/*.test.ts(x)`).
- `pnpm test:watch` - Vitest watch mode.
- `pnpm exec vitest run worker/index.test.ts` - Run one Worker test file.
- `pnpm exec vitest run src/player/whep-reconnect.test.ts` - Run one frontend/player test file.
- `pnpm exec vitest run worker/index.test.ts -t "issues a live token for an authenticated user"` - Run one test case.

## High-level architecture

- Runtime split: Cloudflare Worker backend (`worker/`) plus React + Vite frontend (`src/`), bundled together via `@cloudflare/vite-plugin` (`vite.config.ts`) and deployed with `wrangler.jsonc`.
- Worker HTTP routing is centralized in `worker/index.ts`:
  - `/login`, `/login/callback`, `/logout` for Discord OAuth.
  - `/ingest/:userId*` for WHIP ingest (publisher side).
  - `/play/:userId*` for WHEP playback (viewer side).
  - `/api/*` for authenticated app APIs (`/api/me`, `/api/lives`, `/api/me/livetoken`).
- Discord auth spans `worker/discord-login.ts` + `worker/discord.ts`: OAuth state cookie handshake, code exchange, guild-membership verification, user upsert, JWT cookie (`authtoken`) issuance.
- Cloudflare Calls integration is centralized in `worker/calls.ts` (`startIngest`, `startPlay`, `renegotiateSession`, `closeTracks`).
- D1 persistence is routed through `worker/database.ts` (`live_tracks`, `live_tokens`, `users`), and token auth uses hashed tokens (`token_hash`) rather than raw bearer tokens.
- Untrusted external payloads are validated through Valibot parsers in `worker/validation.ts`.
- End-to-end auth path:
  - Frontend boot (`src/App.tsx`) gates on `useAuth()` (`/api/me`) to resolve `authenticated` / `unauthenticated` / `error`.
  - `/login` starts Discord OAuth; `/login/callback` exchanges code, verifies guild membership, upserts user in D1, then sets `authtoken` cookie.
  - `/api/*` and `/play/*` are protected by cookie JWT middleware.
- End-to-end publish path (WHIP):
  - OBS posts SDP offer to `/ingest/:userId` with bearer token from `/api/me/livetoken`.
  - Worker checks for existing stream state in D1, validates/stale-cleans session, then calls `startIngest`.
  - Returned track metadata is persisted to `live_tracks`; response is SDP answer plus `location` and `etag` headers.
- End-to-end playback path (WHEP):
  - `WHEPPlayer` composes UI state and delegates playback lifecycle to `WHEPVideoPlayer` + `WHEPSession` (`src/player/WHEPVideoPlayer.tsx`, `src/player/WHEPClient.ts`).
  - Client sends local SDP offer to `POST /play/:userId`; server replies with SDP and `location`.
  - `201` means SDP answer (apply directly). `406` means counter-offer (set remote offer, create local answer, `PATCH` to session URL).
  - Reconnect behavior is centralized in `WHEPVideoPlayer` + `whep-reconnect.ts` (bounded retry window + backoff + resume triggers on visibility/pageshow/focus/online).
- Session cleanup behavior:
  - `DELETE /ingest/:userId/:sessionId` closes tracks via Calls and then removes D1 rows.
  - Viewer startup removes stale D1 records when Calls reports a dead publish session.
  - `WHEPSession.dispose()` tears down local WebRTC resources and sends `DELETE` to the server session URL.
- Frontend flow:
  - `src/WHEPPlayer.tsx` composes stream selection, connection controls, playback area, and OBS setup/token issuance.
  - SWR hooks (`useLiveStreams`, `useLiveToken`) manage `/api/lives` and `/api/me/livetoken`.
  - UI copy is Japanese and uses that tone consistently.

## Key conventions for this repository

- Keep frontend API calls relative (`/api/...`, `/play/...`, `/ingest/...`) so Worker + assets work in the same origin setup.
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
- For WHIP/WHEP signaling routes, preserve SDP body/content-type handling, status semantics (`201` vs `406` for WHEP start, `204` for WHEP answer), and `location`/`etag` headers.
- Ingest auth is hash-based bearer validation (`hashed-bearer-auth.ts` + `token-hash.ts`); do not store or compare raw live tokens server-side.
- Keep D1 schema updates synchronized across `schema.sql` and `migrations/` (runtime expects `live_tokens.token_hash`).
- WebRTC/reconnect changes must update setup + teardown + retry paths together (`WHEPClient.ts`, `WHEPVideoPlayer.tsx`, `whep-reconnect.ts`) to avoid stale sessions, leaked timers, or inconsistent resume behavior.
