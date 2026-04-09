import * as v from "valibot";
import {
  CloseTracksResponse,
  DiscordGuildMember,
  DiscordOAuthToken,
  NewSessionResponse,
  NewTracksResponse,
  StoredTrack,
} from "./types";

export class SchemaValidationError extends Error {
  constructor(
    public readonly source: string,
    public readonly details: unknown,
  ) {
    super(`Invalid ${source}`);
    this.name = "SchemaValidationError";
  }
}

const sessionDescriptionSchema = v.object({
  sdp: v.string(),
  type: v.string(),
});

const newSessionResponseSchema = v.object({
  sessionId: v.string(),
});

const newTrackResponseSchema = v.object({
  trackName: v.string(),
  mid: v.string(),
});

const newTracksResponseSchema = v.object({
  tracks: v.array(newTrackResponseSchema),
  sessionDescription: sessionDescriptionSchema,
});

const storedTrackSchema = v.object({
  location: v.literal("remote"),
  sessionId: v.string(),
  trackName: v.string(),
  mid: v.string(),
});

const storedTracksSchema = v.array(storedTrackSchema);

const closeTrackResultSchema = v.object({
  mid: v.string(),
  errorCode: v.optional(v.string()),
  errorDescription: v.optional(v.string()),
  sessionId: v.optional(v.string()),
  trackName: v.optional(v.string()),
});

const closeTracksResponseSchema = v.object({
  errorCode: v.optional(v.string()),
  errorDescription: v.optional(v.string()),
  requiresImmediateRenegotiation: v.optional(v.boolean()),
  sessionDescription: v.optional(sessionDescriptionSchema),
  tracks: v.optional(v.array(closeTrackResultSchema)),
});

const discordUserSchema = v.object({
  id: v.string(),
  username: v.string(),
  discriminator: v.optional(v.nullish(v.string())),
  global_name: v.optional(v.nullish(v.string())),
});

const discordGuildMemberSchema = v.object({
  user: discordUserSchema,
  nick: v.optional(v.nullish(v.string())),
});

const discordOAuthTokenResponseSchema = v.object({
  access_token: v.string(),
  token_type: v.string(),
  expires_in: v.number(),
  refresh_token: v.optional(v.string()),
  scope: v.string(),
});

const liveTrackRowSchema = v.object({
  user_id: v.string(),
  session_id: v.string(),
  tracks_json: v.string(),
});

function parseWithSchema<T>(
  schema: v.GenericSchema<unknown, T>,
  input: unknown,
  source: string,
): T {
  const result = v.safeParse(schema, input);
  if (!result.success) {
    throw new SchemaValidationError(source, result.issues);
  }

  return result.output;
}

export function parseNewSessionResponse(
  input: unknown,
  source: string,
): NewSessionResponse {
  return parseWithSchema(newSessionResponseSchema, input, source);
}

export function parseNewTracksResponse(
  input: unknown,
  source: string,
): NewTracksResponse {
  return parseWithSchema(newTracksResponseSchema, input, source);
}

export function parseCloseTracksResponse(
  input: unknown,
  source: string,
): CloseTracksResponse {
  return parseWithSchema(closeTracksResponseSchema, input, source);
}

export function parseDiscordGuildMember(
  input: unknown,
  source: string,
): DiscordGuildMember {
  return parseWithSchema(discordGuildMemberSchema, input, source);
}

export function parseDiscordOAuthToken(
  input: unknown,
  source: string,
): DiscordOAuthToken {
  const parsed = parseWithSchema(
    discordOAuthTokenResponseSchema,
    input,
    source,
  );

  return {
    accessToken: parsed.access_token,
    expiresIn: parsed.expires_in,
    refreshToken: parsed.refresh_token,
    scope: parsed.scope,
    tokenType: parsed.token_type,
  };
}

export function parseStoredTracksJson(
  input: string,
  source: string,
): StoredTrack[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error) {
    throw new SchemaValidationError(source, error);
  }

  return parseWithSchema(storedTracksSchema, parsed, source);
}

export function parseLiveTrackRow(
  input: unknown,
  source: string,
): {
  user_id: string;
  session_id: string;
  tracks_json: string;
} {
  return parseWithSchema(liveTrackRowSchema, input, source);
}
