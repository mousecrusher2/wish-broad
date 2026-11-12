# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the React 19 + Vite client. App bootstrapping lives in `src/main.tsx` and `src/App.tsx`. API fetching, the SWR hooks (`useBootstrapAuthState`, `useCurrentUser`, `useLiveStreams`, `useLiveToken`), and the auth bootstrap state live in `src/api.ts`. Page-level components (`WHEPPlayerPage.tsx`, `WHEPPlayer.tsx`, `LoginPrompt.tsx`, `OBSStreamingInfo.tsx`) live directly in `src/`, and smaller UI pieces live in `src/components/`. WHEP playback, reconnect behavior, TURN credential fetching, and PeerConnection session logic live in `src/player/`.

`worker/` contains the Cloudflare Worker and Hono routes. `worker/main.ts` is the Worker entrypoint: it exports the Hono app and the Workflow classes, and is the only module that imports `cloudflare:workers`, so keep it thin. `worker/index.ts` is the route composition layer. Keep data access in `worker/database.ts`, Cloudflare Realtime SFU integration in `worker/sfu.ts`, Discord OAuth helpers in `worker/discord.ts` and `worker/discord-login.ts`, live notifications in `worker/notifications.ts`, the reconnect grace period and live-end Workflow body in `worker/live-end.ts`, TURN credential generation in `worker/turn.ts`, and token hashing/authentication helpers in their existing modules.

Static assets live in `public/`. Treat `schema.sql` as the authoritative D1 schema for current development; migrations in `migrations/` record deployment history and must be kept aligned when table shape changes. `wrangler.jsonc` defines Worker bindings, secrets, assets, observability, and deployment settings. Generated Cloudflare binding types live in `worker-configuration.d.ts`, with app-facing aliases in `worker/types.ts`.

Architecture and lifecycle decisions that are not obvious from code live in `docs/architecture.md`; update it when changing ingest/playback lifecycle, SFU reconciliation, notifications, or WHEP negotiation behavior.

## Build, Test, and Development Commands

Run `pnpm install` after cloning. Use `pnpm dev` for local development; the Cloudflare Vite plugin runs the Worker in `workerd` alongside the client. Use `pnpm preview` to build and serve the production bundle locally. Run `pnpm build` to type-check and bundle the client and the Worker. Run `pnpm test` for the Vitest suite and `pnpm test:watch` while iterating.

Run `pnpm check` before opening a PR; it executes TypeScript, oxlint, and `pnpm check:unused-exports` via Knip. `eslint-plugin-better-tailwindcss` is loaded by oxlint as a JS plugin for `src/`; the repo does not run ESLint. Use `pnpm format` to apply Prettier repo-wide and `pnpm format:check` for formatting verification. Run `pnpm schema:check` after editing D1 migrations; it requires the `sqlite3` CLI on `PATH`, replays `migrations/*.sql` into a temporary SQLite database, and compares the resulting schema shape with authoritative `schema.sql`. This mitigates schema drift only; it cannot prove that data migration logic preserves data correctly. `pnpm deploy` builds and publishes the Worker and static assets to Cloudflare.

Do not invoke executables under `node_modules/` directly, including `.cmd` or `.ps1` shims. Always use `pnpm run <script>` for package scripts or `pnpm exec <binary>` for package binaries. In this environment, `pnpm exec ...` may fail under the sandbox and should be rerun with elevated permissions instead of falling back to direct `node_modules` executables.

## Coding Style & Naming Conventions

This repo uses TypeScript ES modules with strict compiler settings and Prettier with `prettier-plugin-tailwindcss` (otherwise defaults: 2-space indentation, semicolons, and double quotes). Follow existing naming: PascalCase for React components (`WHEPPlayer.tsx`), camelCase for utilities, and `useX` for hooks (`useLiveStreams` in `src/api.ts`). Keep protected frontend requests relative to origin, for example `fetch("/api/me", { credentials: "include" })`.

Use Valibot to validate untrusted JSON boundaries. Report failures by throwing. Each external API wrapper throws its own `Error` subclass with a `kind` (`SfuApiError`, `DiscordApiError`, `TurnApiError`, `DiscordWebhookError`, and `WHEPSessionError` on the client), and other failures that callers branch on get a named subclass (`LiveNotFoundError`, `UnauthorizedError`). Document the errors a function throws on purpose with JSDoc `@throws`. Callers that branch on a failure wrap only that call in `try`/`catch`, check the error with `instanceof`, and rethrow what they do not handle. Best-effort work (notifications, track cleanup, token revocation, anything in `waitUntil` or a `finally`) must catch and log at the call site so a failure never replaces the main response. The SWR layer in `src/api.ts` is the exception: its fetchers catch every failure and cache it as `{ status: "error" }` data, because SWR applies a rejected request even after a newer request or a local `mutate` has replaced it. Put new SQL access in `worker/database.ts` rather than scattering queries across route handlers. Keep SFU, Discord, TURN, notification, and token-auth concerns isolated in their existing Worker modules.

## Testing Guidelines

Vitest tests are committed next to most Worker modules (routes, D1 access, SFU, Discord OAuth, notifications, the live-end Workflow body, TURN credentials, live token and bearer auth helpers, JWT helpers, and logging) and for the frontend API layer and WHEP player (`WHEPClient`, `WHEPPlaybackController`, reconnect policy, and TURN parsing). Add tests as `*.test.ts` or `*.test.tsx` near the feature they cover. Prefer focused tests around protocol edges, schema validation, retry/reconnect timing, and Worker response status/header behavior.

Treat `pnpm test` and `pnpm check` as the minimum automated validation for code changes. For Worker/WebRTC changes, also manually verify the affected flows locally: `/api/me`, `/api/lives`, live token creation, WHIP publish through `/ingest/:userId`, WHEP playback through `/play/:userId`, TURN credential retrieval, and live start notification cleanup when relevant, including an OBS reconnect within the 60-second grace period (no second notification) and a stop that ends the broadcast after it.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style prefixes such as `fix:` and `feat:`; keep that pattern and make each commit a single logical change. PRs should include a short scope summary, note any updates to `schema.sql`, `migrations/`, `wrangler.jsonc`, or generated Cloudflare types, link related issues, and attach screenshots for UI changes. Include the automated and manual verification steps you ran.

## Security & Configuration Tips

Keep secrets in `.dev.vars`, which is gitignored, and keep binding names aligned between `wrangler.jsonc` and `.dev.vars`. `worker/types.ts` only aliases the generated binding types. Required production secrets include Discord OAuth/guild values, Cloudflare Realtime SFU app credentials, JWT and live-token pepper values, notification webhook URL, and TURN key credentials.

`LOG_LEVEL` is a non-secret Worker variable for structured application logs; use `debug`, `info`, `warn`, `error`, or `silent`.

Live ingest tokens are only displayed on creation, stored as HMAC hashes, and verified through bearer auth on `/ingest/:userId/*`; do not log raw tokens. After changing Worker bindings or environment types, run `pnpm cf-typegen` to refresh generated Cloudflare types.
