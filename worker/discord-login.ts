import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sign } from "hono/jwt";
import { Context } from "hono";
import { setUser } from "./database";
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
} from "./discord";
import { calcJwtTimestamps, JWT_DURATION_SECONDS } from "./jwt-utils";
import { Bindings, JWTPayload } from "./types";

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
    [401, 403, 404].includes(error.statusCode ?? 0)
  );
}

async function issueDiscordLoginJwt<E extends ContextWithBindings>(
  c: Context<E>,
  member: DiscordGuildMember,
): Promise<Response> {
  const displayName =
    member.nick || member.user.global_name || member.user.username;

  await setUser(c.env.LIVE_DB, {
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

  let accessToken: string | null = null;
  const revokeAccessTokenIfNeeded = async () => {
    if (accessToken) {
      const revokeResult = await revokeAccessToken(c.env, accessToken);
      if (revokeResult.isErr()) {
        console.warn("Failed to revoke OAuth token:", revokeResult.error);
      }
    }
  };

  const oauthTokenResult = await exchangeCodeForToken(
    c.env,
    authorizationCode,
    getDiscordRedirectUri(c),
  );
  if (oauthTokenResult.isErr()) {
    console.error("Discord login failed:", oauthTokenResult.error);
    return c.text(
      `Discord login failed: ${getDiscordErrorMessage(oauthTokenResult.error)}`,
      502,
    );
  }

  accessToken = oauthTokenResult.value.accessToken;

  const memberResult = await getGuildMember(accessToken, c.env.AUTHORIZED_GUILD_ID);
  if (memberResult.isErr()) {
    console.error("Discord login failed:", memberResult.error);
    await revokeAccessTokenIfNeeded();

    if (isGuildMembershipLookupFailure(memberResult.error, c.env.AUTHORIZED_GUILD_ID)) {
      return c.text(
        "Unauthorized: You are not a member of the authorized Discord server",
        401,
      );
    }

    return c.text(
      `Discord login failed: ${getDiscordErrorMessage(memberResult.error)}`,
      502,
    );
  }

  try {
    return await issueDiscordLoginJwt(c, memberResult.value);
  } finally {
    await revokeAccessTokenIfNeeded();
  }
}
