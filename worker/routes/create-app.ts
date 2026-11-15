import { HonoBase } from "hono/hono-base";
import { LinearRouter } from "hono/router/linear-router";
import type { AppEnv } from "../types";

/** ルートを登録する Hono アプリ。`app.ts` がこれらを 1 つのアプリにまとめる。 */
export function createApp() {
  return new HonoBase<AppEnv>({ router: new LinearRouter() });
}
