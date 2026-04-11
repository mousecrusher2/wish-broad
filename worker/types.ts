export type NewSessionResponse = {
  sessionId: string;
};

export type NewTrackResponse = {
  trackName: string;
  mid?: string | undefined;
  sessionId?: string | undefined;
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
};

export type NewTracksResponse = {
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
  requiresImmediateRenegotiation?: boolean | undefined;
  tracks?: NewTrackResponse[] | undefined;
  sessionDescription?: SessionDescription | undefined;
};

export type SessionDescription = {
  sdp: string;
  type: string;
};

export type TrackLocator = {
  location: string;
  sessionId: string;
  trackName: string;
};

export type StoredTrack = TrackLocator & {
  mid: string;
};

export type CloseTrackResult = {
  mid: string;
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
  sessionId?: string | undefined;
  trackName?: string | undefined;
};

export type CloseTracksResponse = {
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
  requiresImmediateRenegotiation?: boolean | undefined;
  sessionDescription?: SessionDescription | undefined;
  tracks?: CloseTrackResult[] | undefined;
};

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

export type DiscordUser = {
  id: string;
  username: string;
  discriminator?: string | null | undefined;
  global_name?: string | null | undefined;
};

export type DiscordGuildMember = {
  user: DiscordUser;
  nick?: string | null | undefined;
};

export type DiscordOAuthToken = {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  scope: string;
  refreshToken?: string | undefined;
};

export type User = {
  userId: string;
  displayName: string;
};

export type Live = {
  owner: User;
};
