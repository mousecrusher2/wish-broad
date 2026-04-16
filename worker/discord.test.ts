import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDiscordAuthorizationUrl,
  exchangeCodeForToken,
  revokeAccessToken,
} from "./discord";

describe("worker discord helpers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("builds a Discord authorization URL with the configured scopes", () => {
    const url = new URL(
      buildDiscordAuthorizationUrl(
        {
          DISCORD_CLIENT_ID: "client-id",
        },
        "https://example.com/login",
        "state-123",
      ),
    );

    expect(url.origin + url.pathname).toBe(
      "https://discord.com/oauth2/authorize",
    );
    expect(url.searchParams.get("client_id")).toBe("client-id");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://example.com/login",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe("identify guilds.members.read");
    expect(url.searchParams.get("state")).toBe("state-123");
  });

  it("returns an error result when token exchange returns a non-JSON error body", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>rate limited</html>", {
        headers: {
          "Content-Type": "text/html",
        },
        status: 429,
        statusText: "Too Many Requests",
      }),
    );

    const result = await exchangeCodeForToken(
      {
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
      },
      "auth-code",
      "https://example.com/login",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected token exchange to fail");
    }

    expect(result.error).toMatchObject({
      endpoint: "https://discord.com/api/v10/oauth2/token",
      responseBodyText: "<html>rate limited</html>",
      statusCode: 429,
      statusText: "Too Many Requests",
    });
  });

  it("returns an error result when token revocation fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ message: "bad gateway" }), {
        headers: {
          "Content-Type": "application/json",
        },
        status: 502,
        statusText: "Bad Gateway",
      }),
    );

    const result = await revokeAccessToken(
      {
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
      },
      "discord-access-token",
    );

    expect(result.isErr()).toBe(true);
    if (result.isOk()) {
      throw new Error("Expected token revocation to fail");
    }

    expect(result.error).toMatchObject({
      endpoint: "https://discord.com/api/v10/oauth2/token/revoke",
      statusCode: 502,
      statusText: "Bad Gateway",
    });
  });
});
