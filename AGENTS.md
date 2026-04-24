# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the React 19 + Vite client. App bootstrapping and auth flow live in `src/App.tsx`, `src/main.tsx`, `src/useAuth.ts`, and related `useX` hooks. UI components live in `src/components/`, while WHEP playback, reconnect behavior, TURN credential fetching, and PeerConnection session logic live in `src/player/`.

`worker/` contains the Cloudflare Worker and Hono routes. `worker/index.ts` is the entrypoint and route composition layer; keep data access in `worker/database.ts`, Cloudflare Calls/SFU integration in `worker/sfu.ts`, Discord OAuth helpers in `worker/discord.ts` and `worker/discord-login.ts`, live notifications in `worker/notifications.ts`, TURN credential generation in `worker/turn.ts`, and token hashing/authentication helpers in their existing modules.

Static assets live in `public/`. D1 schema history lives in `migrations/`; keep `schema.sql` as the local schema snapshot when changing tables. `wrangler.jsonc` defines Worker bindings, secrets, assets, observability, and deployment settings. Generated Cloudflare binding types live in `worker-configuration.d.ts`, with app-facing aliases in `worker/types.ts`.

## Build, Test, and Development Commands

Run `pnpm install` after cloning. Use `pnpm dev` for the Vite client, `pnpm dev:worker` for a local Worker-only session, and `pnpm dev:full` when you need Wrangler to serve the integrated app. Run `pnpm build` to type-check and bundle the frontend. Run `pnpm test` for the Vitest suite and `pnpm test:watch` while iterating.

Run `pnpm check` before opening a PR; it executes TypeScript, ESLint, and `pnpm check:unused-exports` via Knip. Use `pnpm format` to apply Prettier defaults repo-wide and `pnpm format:check` for formatting verification. `pnpm build:analyze` emits bundle analysis artifacts, and `pnpm deploy` builds and publishes the Worker and static assets to Cloudflare.

Do not invoke executables under `node_modules/` directly, including `.cmd` or `.ps1` shims. Always use `pnpm run <script>` for package scripts or `pnpm exec <binary>` for package binaries. In this environment, `pnpm exec ...` may fail under the sandbox and should be rerun with elevated permissions instead of falling back to direct `node_modules` executables.

## Coding Style & Naming Conventions

This repo uses TypeScript ES modules with strict compiler settings and Prettier defaults: 2-space indentation, semicolons, and double quotes. Follow existing naming: PascalCase for React components (`WHEPPlayer.tsx`), camelCase for utilities, and `useX` for hooks (`useLiveStreams.ts`). Keep protected frontend requests relative to origin, for example `fetch("/api/me", { credentials: "include" })`.

Use Valibot to validate untrusted JSON boundaries, and use `neverthrow` `Result` values where existing modules already follow that pattern. Put new SQL access in `worker/database.ts` rather than scattering queries across route handlers. Keep SFU, Discord, TURN, notification, and token-auth concerns isolated in their existing Worker modules.

## Testing Guidelines

Vitest tests are committed for Worker routes and helpers, Discord OAuth, notifications, TURN credentials, frontend TURN parsing, and WHEP reconnect behavior. Add tests as `*.test.ts` or `*.test.tsx` near the feature they cover. Prefer focused tests around protocol edges, schema validation, retry/reconnect timing, and Worker response status/header behavior.

Treat `pnpm test` and `pnpm check` as the minimum automated validation for code changes. For Worker/WebRTC changes, also manually verify the affected Wrangler flows: Discord login, `/api/me`, `/api/lives`, live token creation, WHIP publish through `/ingest/:userId`, WHEP playback through `/play/:userId`, TURN credential retrieval, and live start notification cleanup when relevant.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style prefixes such as `fix:` and `feat:`; keep that pattern and make each commit a single logical change. PRs should include a short scope summary, note any updates to `schema.sql`, `migrations/`, `wrangler.jsonc`, or generated Cloudflare types, link related issues, and attach screenshots for UI changes. Include the automated and manual verification steps you ran.

## Security & Configuration Tips

Keep secrets in `.dev.vars`, which is gitignored, and keep binding names aligned across `wrangler.jsonc`, `.dev.vars`, and `worker/types.ts`. Required production secrets include Discord OAuth/guild values, Cloudflare Calls credentials, JWT and live-token pepper values, notification webhook URL, and TURN key credentials.

Live ingest tokens are only displayed on creation, stored as HMAC hashes, and verified through bearer auth on `/ingest/:userId/*`; do not log raw tokens. After changing Worker bindings or environment types, run `pnpm cf-typegen` to refresh generated Cloudflare types.
