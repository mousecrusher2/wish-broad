export type JWTPayload = {
  iat: number;
  exp: number;
  userId: string;
  displayName: string;
};

export type Bindings = {
  CALLS_APP_ID: string;
  CALLS_APP_SECRET: string;
  JWT_SECRET: string;
  LIVE_TOKEN_PEPPER: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  AUTHORIZED_GUILD_ID: string;
  ENVIRONMENT?: string | undefined; // "development" | "production"
  LIVE_DB: D1Database;
};
