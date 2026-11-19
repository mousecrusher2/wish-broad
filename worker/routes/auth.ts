// Discord OAuth によるログインとログアウト（docs/architecture.md「認証とトークン」）。
import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { sign } from "hono/jwt";
import {
  buildDiscordAuthorizationUrl,
  createOAuthState,
  DiscordApiError,
  type DiscordGuildMember,
  exchangeCodeForToken,
  getDiscordErrorMessage,
  getGuildMember,
  revokeAccessToken,
} from "../clients/discord-oauth";
import { calcJwtTimestamps, JWT_DURATION_SECONDS } from "../lib/jwt-utils";
import { createErrorLogFields, logError, logWarn } from "../lib/logger";
import { AUTH_COOKIE_NAME } from "../middleware/app-jwt";
import { getLiveState } from "../state/live-state";
import type { AppEnv, Bindings, JWTPayload } from "../types";
import { createApp } from "./create-app";

const DISCORD_STATE_COOKIE_NAME = "discord_oauth_state";
const DISCORD_STATE_MAX_AGE_SECONDS = 60 * 10;

export const authRoutes = createApp();

function isProductionEnvironment(env: Pick<Bindings, "ENVIRONMENT">): boolean {
  return env.ENVIRONMENT === "production";
}

function getDiscordStateCookieOptions(env: Pick<Bindings, "ENVIRONMENT">): {
  httpOnly: true;
  maxAge: number;
  path: "/login";
  sameSite: "Lax";
  secure: boolean;
} {
  return {
    httpOnly: true,
    maxAge: DISCORD_STATE_MAX_AGE_SECONDS,
    path: "/login",
    sameSite: "Lax",
    secure: isProductionEnvironment(env),
  };
}

function getDiscordRedirectUri(c: Context<AppEnv>): string {
  const url = new URL(c.req.url);
  url.hash = "";
  url.pathname = "/login/callback";
  url.search = "";
  return url.toString();
}

function isGuildMembershipLookupFailure(
  error: DiscordApiError,
  guildId: string,
): boolean {
  return (
    error.endpoint.endsWith(`/users/@me/guilds/${guildId}/member`) &&
    (error.kind === "unauthorized" ||
      error.kind === "forbidden" ||
      error.kind === "not_found")
  );
}

async function issueDiscordLoginJwt(
  c: Context<AppEnv>,
  member: DiscordGuildMember,
): Promise<Response> {
  const displayName =
    member.nick ?? member.user.global_name ?? member.user.username;

  await getLiveState(c.env).setUser({
    userId: member.user.id,
    displayName,
  });

  const { iat, exp } = calcJwtTimestamps(JWT_DURATION_SECONDS.ONE_DAY);
  const payload: JWTPayload = {
    iat,
    exp,
    userId: member.user.id,
    displayName,
  };
  const jwtToken = await sign(payload, c.env.JWT_SECRET, "HS256");

  setCookie(c, AUTH_COOKIE_NAME, jwtToken, {
    expires: new Date(Date.now() + JWT_DURATION_SECONDS.ONE_DAY * 1000),
    httpOnly: true,
    secure: isProductionEnvironment(c.env),
    sameSite: "Strict",
  });

  return c.redirect("/");
}

/** アクセストークンを失効させ、waitUntil 内で実行されるため失敗はスローせずログ出力する。 */
async function revokeAccessTokenQuietly(
  env: Bindings,
  accessToken: string,
): Promise<void> {
  try {
    await revokeAccessToken(env, accessToken);
  } catch (error: unknown) {
    logWarn(env, "discord.oauth_revoke_failed", createErrorLogFields(error));
  }
}

authRoutes.get("/login", (c) => {
  const state = createOAuthState();
  setCookie(
    c,
    DISCORD_STATE_COOKIE_NAME,
    state,
    getDiscordStateCookieOptions(c.env),
  );
  return c.redirect(
    buildDiscordAuthorizationUrl(c.env, getDiscordRedirectUri(c), state),
  );
});

authRoutes.get("/login/callback", async (c) => {
  const authorizationCode = c.req.query("code");
  const returnedState = c.req.query("state");
  const discordError = c.req.query("error");
  const discordErrorDescription = c.req.query("error_description");

  const storedState = getCookie(c, DISCORD_STATE_COOKIE_NAME);
  deleteCookie(c, DISCORD_STATE_COOKIE_NAME, {
    path: "/login",
    sameSite: "Lax",
    secure: isProductionEnvironment(c.env),
  });

  if (!storedState || !returnedState || storedState !== returnedState) {
    return c.text("Invalid OAuth state", 400);
  }

  if (discordError) {
    return c.text(
      `Discord authorization failed: ${discordErrorDescription ?? discordError}`,
      401,
    );
  }

  if (!authorizationCode) {
    return c.text("Authorization code is required", 400);
  }

  let accessToken: string;
  try {
    ({ accessToken } = await exchangeCodeForToken(
      c.env,
      authorizationCode,
      getDiscordRedirectUri(c),
    ));
  } catch (error: unknown) {
    if (!(error instanceof DiscordApiError)) {
      throw error;
    }
    logError(c.env, "discord.login_token_exchange_failed", {
      ...createErrorLogFields(error),
    });
    return c.text(
      `Discord login failed: ${getDiscordErrorMessage(error)}`,
      502,
    );
  }

  // Discord のアクセストークンはサーバーへの所属確認にしか使わないため、ログインの成否に
  // かかわらず確認後に、応答を待たせずに失効させる（docs/architecture.md「認証とトークン」）。
  try {
    let member: DiscordGuildMember;
    try {
      member = await getGuildMember(accessToken, c.env.AUTHORIZED_GUILD_ID);
    } catch (error: unknown) {
      if (!(error instanceof DiscordApiError)) {
        throw error;
      }
      logError(c.env, "discord.login_member_check_failed", {
        ...createErrorLogFields(error),
        guildId: c.env.AUTHORIZED_GUILD_ID,
      });
      return isGuildMembershipLookupFailure(error, c.env.AUTHORIZED_GUILD_ID)
        ? c.text(
            "Unauthorized: You are not a member of the authorized Discord server",
            401,
          )
        : c.text(`Discord login failed: ${getDiscordErrorMessage(error)}`, 502);
    }

    return await issueDiscordLoginJwt(c, member);
  } finally {
    c.executionCtx.waitUntil(revokeAccessTokenQuietly(c.env, accessToken));
  }
});

authRoutes.post("/logout", csrf(), async (c) => {
  deleteCookie(c, AUTH_COOKIE_NAME, {
    secure: isProductionEnvironment(c.env),
  });
  return c.redirect("/");
});
