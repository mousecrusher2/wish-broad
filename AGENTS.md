# Repository Guidelines

## Project Structure & Module Organization

`src/` contains the React 19 + Vite client. Keep UI components in `src/components/`, WebRTC and page lifecycle logic in `src/hooks/`, and app-level auth/bootstrapping in files like `src/App.tsx` and `src/main.tsx`. `worker/` contains the Cloudflare Worker and Hono routes; `worker/index.ts` is the entrypoint, while modules such as `worker/database.ts`, `worker/calls.ts`, and `worker/discord.ts` isolate integrations and data access. Static assets live in `public/`. `schema.sql` defines the D1 schema, and `wrangler.jsonc` defines Worker bindings and deployment settings.

## Build, Test, and Development Commands

Run `pnpm install` after cloning. Use `pnpm dev` for the Vite client, `pnpm dev:worker` for a local Worker-only session, and `pnpm dev:full` when you need Wrangler to serve the integrated app. Run `pnpm build` to type-check and bundle the frontend. Run `pnpm check` before opening a PR; it executes TypeScript and ESLint. Use `pnpm format` to apply Prettier defaults repo-wide. `pnpm deploy` publishes the Worker and static assets to Cloudflare.

## Coding Style & Naming Conventions

This repo uses TypeScript ES modules with Prettier defaults: 2-space indentation, semicolons, and double quotes. Follow existing naming: PascalCase for React components (`WHEPPlayer.tsx`), camelCase for utilities, and `useX` for hooks (`useLiveStreams.ts`). Keep protected frontend requests relative to origin, for example `fetch("/api/me", { credentials: "include" })`. Put new SQL access in `worker/database.ts` rather than scattering queries across route handlers.

## Testing Guidelines

There is no committed automated test suite or coverage threshold yet. Treat `pnpm check` as the minimum validation step, then manually verify login, `/api/me`, `/api/lives`, and publish/play flows in Wrangler. If you add tests, prefer `*.test.ts` or `*.test.tsx` near the feature they cover.

## Commit & Pull Request Guidelines

Recent history uses Conventional Commit-style prefixes such as `fix:` and `feat:`; keep that pattern and make each commit a single logical change. PRs should include a short scope summary, note any updates to `schema.sql` or `wrangler.jsonc`, link related issues, and attach screenshots for UI changes. Include the manual verification steps you ran.

## Security & Configuration Tips

Keep secrets in `.dev.vars`, which is gitignored, and keep binding names aligned across `wrangler.jsonc`, `.dev.vars`, and `worker/types.ts`. After changing Worker bindings, run `pnpm cf-typegen` to refresh generated Cloudflare types.
