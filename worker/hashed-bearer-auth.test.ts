import { Hono, type Context } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashTokenWithPepper } from "./token-hash";
import { hashedBearerAuth } from "./hashed-bearer-auth";

type AuthEnv = { Bindings: { pepper: string; tokenHash: string | null } };

function createApp(
  pepper: string | ((context: Context<AuthEnv>) => string | Promise<string>),
  token:
    | string
    | null
    | ((context: Context<AuthEnv>) => string | null | Promise<string | null>),
  realm?: string,
) {
  const app = new Hono<AuthEnv>();
  app.get(
    "/secure",
    hashedBearerAuth<AuthEnv>({
      pepper,
      token,
      ...(realm === undefined ? {} : { realm }),
    }),
    (context) => context.text("accepted"),
  );
  return app;
}

describe("hashed bearer authentication middleware", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts a valid case-insensitive Bearer scheme and resolves request bindings", async () => {
    const tokenHash = await hashTokenWithPepper("secret-pepper", "live-token");
    const app = createApp(
      (context) => context.env.pepper,
      async (context) => context.env.tokenHash,
    );

    const response = await app.request(
      "/secure",
      { headers: { Authorization: "  bEaReR   live-token  " } },
      { pepper: "secret-pepper", tokenHash },
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("accepted");
  });

  it("does not accept the right token with a different scheme or extra field", async () => {
    const tokenHash = await hashTokenWithPepper("pepper", "live-token");
    const app = createApp("pepper", tokenHash);

    const responses = await Promise.all(
      ["Basic live-token", "Bearer live-token extra"].map((authorization) =>
        Promise.resolve(
          app.request("/secure", {
            headers: { Authorization: authorization },
          }),
        ),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([401, 401]);
    await expect(
      Promise.all(responses.map((response) => response.text())),
    ).resolves.toEqual(["Unauthorized", "Unauthorized"]);
  });

  it.each([
    undefined,
    "Basic live-token",
    "Bearer",
    "Bearer token extra",
    "Bearer   ",
  ])("rejects malformed Authorization headers: %s", async (authorization) => {
    const tokenHash = await hashTokenWithPepper("pepper", "token");
    const app = createApp("pepper", tokenHash, "stream ingest");

    const response = await app.request("/secure", {
      headers:
        authorization === undefined ? {} : { Authorization: authorization },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="stream ingest"',
    );
    await expect(response.text()).resolves.toBe("Unauthorized");
  });

  it("uses the default challenge when no realm is configured", async () => {
    const response = await createApp("pepper", "hash").request("/secure");

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("rejects absent stored hashes before resolving the pepper", async () => {
    const pepper = vi.fn<() => string>(() => "pepper");
    const app = createApp(pepper, null);
    const response = await app.request("/secure", {
      headers: { Authorization: "Bearer token" },
    });

    expect(response.status).toBe(401);
    expect(pepper).not.toHaveBeenCalled();
  });

  it("rejects wrong tokens and malformed stored hashes without calling the route", async () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const tokenHash = await hashTokenWithPepper("pepper", "right-token");
    const app = createApp("pepper", tokenHash);

    const invalidToken = await app.request("/secure", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(invalidToken.status).toBe(401);
    expect(warn).not.toHaveBeenCalled();

    const malformedHashApp = createApp("pepper", "not-hex");
    const malformedHash = await malformedHashApp.request(
      "/secure",
      {
        headers: { Authorization: "Bearer right-token" },
      },
      { pepper: "pepper", tokenHash: null },
    );
    expect(malformedHash.status).toBe(401);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: "Invalid token hash",
        event: "bearer_token.verify_failed",
        level: "error",
      }),
    );
  });
});
