import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign } from "hono/jwt";
import { Context } from "hono";
import {
  buildDiscordAuthorizationUrl,
  createOAuthState,
  DiscordApiError,
  type DiscordGuildMember,
  DISCORD_STATE_COOKIE_NAME,
  DISCORD_STATE_MAX_AGE_SECONDS,
  exchangeCodeForToken,
  getDiscordErrorMessage,
  getGuildMember,
  revokeAccessToken,
} from "../clients/discord-oauth";
import { calcJwtTimestamps, JWT_DURATION_SECONDS } from "../lib/jwt-utils";
import { getLiveState } from "../state/live-state";
import { Bindings, JWTPayload } from "../types";
import { createErrorLogFields, logError, logWarn } from "../lib/logger";

type ContextWithBindings = { Bindings: Bindings };

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

function getDiscordRedirectUri<E extends ContextWithBindings>(
  c: Context<E>,
): string {
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

async function issueDiscordLoginJwt<E extends ContextWithBindings>(
  c: Context<E>,
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

  setCookie(c, "authtoken", jwtToken, {
    expires: new Date(Date.now() + JWT_DURATION_SECONDS.ONE_DAY * 1000),
    httpOnly: true,
    secure: isProductionEnvironment(c.env),
    sameSite: "Strict",
  });

  return c.redirect("/");
}

export function clearAuthCookie<E extends ContextWithBindings>(
  c: Context<E>,
): void {
  deleteCookie(c, "authtoken", {
    secure: isProductionEnvironment(c.env),
  });
}

export function startDiscordLogin<E extends ContextWithBindings>(
  c: Context<E>,
): Response {
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
}

export async function completeDiscordLogin<E extends ContextWithBindings>(
  c: Context<E>,
): Promise<Response> {
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
  // かかわらず確認後に失効させる（docs/architecture.md「認証とトークン」）。
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
    await revokeAccessTokenQuietly(c.env, accessToken);
  }
}

/**
 * アクセストークンを失効させ、失敗はログ出力だけで済ませる。`finally` 内で呼ぶため、
 * スローするとログインのレスポンスがエラーで置き換わってしまう。
 */
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
