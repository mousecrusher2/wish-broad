export type NewSessionResponse = {
  sessionId: string;
};

export type NewTrackResponse = {
  trackName: string;
  mid: string;
};

export type NewTracksResponse = {
  tracks: NewTrackResponse[];
  sessionDescription: SessionDescription;
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

export type JWTPayload = {
  iat: number;
  exp: number;
  userId: string;
  displayName: string;
};

export type Bindings = {
  CALLS_APP_ID: string;  CALLS_APP_SECRET: string;
  INGEST_BEARER_TOKEN: string;
  JWT_SECRET: string;
  DISCORD_CLIENT_ID: string;
  DISCORD_CLIENT_SECRET: string;
  AUTHORIZED_GUILD_ID: string;
  ENVIRONMENT?: string; // "development" | "production"
  LIVE_DB: D1Database;
};

export type DiscordUser = {
  id: string;
  username: string;
  discriminator: string;
  global_name?: string;
}

export type DiscordGuildMember = {
  user: DiscordUser;
  nick?: string;
}
