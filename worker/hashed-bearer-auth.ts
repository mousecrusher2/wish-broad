import type { Context, MiddlewareHandler } from "hono";
import { verifyTokenHash } from "./token-hash";

type MaybePromise<T> = T | Promise<T>;

type ResolveableValue<
  E extends { Bindings: object },
  P extends string,
  T extends string | null,
> =
  | T
  | ((c: Context<E, P>) => MaybePromise<T>);

type HashedBearerAuthOptions<
  E extends { Bindings: object },
  P extends string,
> = {
  pepper: ResolveableValue<E, P, string>;
  realm?: string;
  token: ResolveableValue<E, P, string | null>;
};

type TokenCheckResult =
  | { kind: "ok"; isValidToken: boolean }
  | { kind: "error"; error: Error };

function getBearerToken(
  authorizationHeader: string | undefined,
): string | null {
  if (!authorizationHeader) {
    return null;
  }

  const [scheme, token, ...rest] = authorizationHeader.trim().split(/\s+/u);
  if (scheme?.toLowerCase() !== "bearer" || !token || rest.length > 0) {
    return null;
  }

  return token;
}

function createUnauthorizedResponse(realm?: string): Response {
  const headers = new Headers();
  headers.set("WWW-Authenticate", realm ? `Bearer realm="${realm}"` : "Bearer");

  return new Response("Unauthorized", {
    headers,
    status: 401,
  });
}

async function resolveValue<
  E extends { Bindings: object },
  P extends string,
  T extends string | null,
>(value: ResolveableValue<E, P, T>, c: Context<E, P>): Promise<T> {
  if (typeof value === "function") {
    return value(c);
  }

  return value;
}

export function hashedBearerAuth<
  E extends { Bindings: object },
  P extends string = string,
>(options: HashedBearerAuthOptions<E, P>): MiddlewareHandler<E, P> {
  return async (c, next) => {
    const bearerToken = getBearerToken(c.req.header("authorization"));
    if (!bearerToken) {
      return createUnauthorizedResponse(options.realm);
    }

    const expectedTokenHash = await resolveValue(options.token, c);
    if (!expectedTokenHash) {
      return createUnauthorizedResponse(options.realm);
    }

    const pepper = await resolveValue(options.pepper, c);
    const tokenCheck: TokenCheckResult = await verifyTokenHash(
      pepper,
      bearerToken,
      expectedTokenHash,
    )
      .then(
        (isValidToken): TokenCheckResult => ({ kind: "ok", isValidToken }),
      )
      .catch((error: Error): TokenCheckResult => ({ kind: "error", error }));

    if (tokenCheck.kind === "error") {
      console.error("Failed to verify bearer token hash:", tokenCheck.error);
      return createUnauthorizedResponse(options.realm);
    }

    if (!tokenCheck.isValidToken) {
      return createUnauthorizedResponse(options.realm);
    }

    await next();
  };
}
