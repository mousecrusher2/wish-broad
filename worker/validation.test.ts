import { describe, expect, it } from "vitest";
import {
  SchemaValidationError,
  parseCloseTracksResponse,
  parseDiscordGuildMember,
  parseDiscordOAuthToken,
  parseStoredTracksJson,
} from "./validation";

describe("worker validation", () => {
  it("parses stored tracks saved in D1", () => {
    const parsed = parseStoredTracksJson(
      JSON.stringify([
        {
          location: "remote",
          mid: "0",
          sessionId: "session-1",
          trackName: "video",
        },
      ]),
      "D1 live_tracks.tracks_json",
    );

    expect(parsed).toEqual([
      {
        location: "remote",
        mid: "0",
        sessionId: "session-1",
        trackName: "video",
      },
    ]);
  });

  it("rejects malformed stored tracks", () => {
    expect(() =>
      parseStoredTracksJson(
        JSON.stringify([
          {
            location: "remote",
            sessionId: "session-1",
            trackName: "video",
          },
        ]),
        "D1 live_tracks.tracks_json",
      ),
    ).toThrow(SchemaValidationError);
  });

  it("accepts Discord member payloads with nullable names", () => {
    const parsed = parseDiscordGuildMember(
      {
        nick: null,
        user: {
          discriminator: null,
          global_name: null,
          id: "user-1",
          username: "alice",
        },
      },
      "Discord guild member response",
    );

    expect(parsed).toEqual({
      nick: null,
      user: {
        discriminator: null,
        global_name: null,
        id: "user-1",
        username: "alice",
      },
    });
  });

  it("parses Discord OAuth token responses", () => {
    const parsed = parseDiscordOAuthToken(
      {
        access_token: "access-token",
        expires_in: 3600,
        refresh_token: "refresh-token",
        scope: "identify guilds.members.read",
        token_type: "Bearer",
      },
      "Discord OAuth token response",
    );

    expect(parsed).toEqual({
      accessToken: "access-token",
      expiresIn: 3600,
      refreshToken: "refresh-token",
      scope: "identify guilds.members.read",
      tokenType: "Bearer",
    });
  });

  it("rejects malformed track-close responses", () => {
    expect(() =>
      parseCloseTracksResponse(
        {
          tracks: [{ errorCode: "failed_to_close" }],
        },
        "Calls closeTracks response",
      ),
    ).toThrow(SchemaValidationError);
  });
});
