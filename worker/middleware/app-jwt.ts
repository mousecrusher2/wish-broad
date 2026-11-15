import type { MiddlewareHandler } from "hono";
import { csrf } from "hono/csrf";
import { jwt } from "hono/jwt";
import { logInfo } from "../lib/logger";
import type { AppEnv } from "../types";

/** アプリの JWT を保持する Cookie。ログイン時に発行し、視聴と API の認証に使う。 */
export const AUTH_COOKIE_NAME = "authtoken";

/**
 * アプリの JWT Cookie で認証されたブラウザからのリクエストだけを通すミドルウェア群。
 * 認証できたリクエストは `requestEvent` としてログ出力する。
 */
export function appJwtAuth(requestEvent: string): MiddlewareHandler<AppEnv>[] {
  return [
    csrf(),
    async (c, next) => {
      const middleware = jwt({
        secret: c.env.JWT_SECRET,
        cookie: AUTH_COOKIE_NAME,
        alg: "HS256",
      });
      // oxlint-disable-next-line typescript/no-unsafe-argument -- Hono の jwt ミドルウェアが具象的なアプリコンテキスト型を消去するため。
      return middleware(c, next);
    },
    async (c, next) => {
      logInfo(c.env, requestEvent, { userId: c.get("jwtPayload").userId });
      await next();
    },
  ];
}
