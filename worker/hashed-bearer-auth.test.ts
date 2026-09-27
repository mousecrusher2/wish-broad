import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashedBearerAuth } from "./hashed-bearer-auth";
import { hashTokenWithPepper } from "./token-hash";

function createApp(options: Parameters<typeof hashedBearerAuth>[0]) {
  const app = new Hono();
  const handler = vi.fn(() => new Response("allowed", { status: 200 }));
  app.use("/protected", hashedBearerAuth(options));
  app.get("/protected", handler);
  return { app, handler };
}

describe("hashed bearer authentication", () => {
  afterEach(() => vi.restoreAllMocks());

  it("requires exactly one Bearer credential and includes the configured realm", async () => {
    const hash = await hashTokenWithPepper("pepper", "secret");
    const { app, handler } = createApp({
      pepper: "pepper",
      token: hash,
      realm: "ingest",
    });
    for (const authorization of [
      undefined,
      "",
      "Basic secret",
      "Bearer",
      "Bearer secret extra",
      "Bearer  ",
    ]) {
      const response = await app.request(
        "/protected",
        authorization ? { headers: { authorization } } : {},
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe(
        'Bearer realm="ingest"',
      );
      expect(await response.text()).toBe("Unauthorized");
    }
    expect(handler).not.toHaveBeenCalled();
    const valid = await app.request("/protected", {
      headers: { authorization: "  bEaReR   secret  " },
    });
    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe("allowed");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("rejects missing, mismatched, and malformed stored hashes", async () => {
    const hash = await hashTokenWithPepper("pepper", "secret");
    for (const token of [null, "", hash, "invalid-hash"]) {
      const { app, handler } = createApp({ pepper: "pepper", token });
      const result = await app.request(
        "/protected",
        {
          headers: { authorization: "Bearer wrong" },
        },
        { LOG_LEVEL: "silent" },
      );
      expect(result.status).toBe(401);
      expect(result.headers.get("www-authenticate")).toBe("Bearer");
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("resolves token and pepper from the Hono context", async () => {
    const hash = await hashTokenWithPepper("pepper", "secret");
    const token = vi.fn(async () => hash);
    const pepper = vi.fn(async () => "pepper");
    const { app } = createApp({ token, pepper });
    expect(
      (
        await app.request("/protected", {
          headers: { authorization: "Bearer secret" },
        })
      ).status,
    ).toBe(200);
    expect(token).toHaveBeenCalledOnce();
    expect(pepper).toHaveBeenCalledOnce();
  });

  it("logs a malformed stored hash and denies the request", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const { app, handler } = createApp({
      pepper: "pepper",
      token: "not-hex",
      realm: "live",
    });
    const response = await app.request(
      "/protected",
      { headers: { authorization: "Bearer secret" } },
      { LOG_LEVEL: "info" },
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="live"',
    );
    expect(handler).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "bearer_token.verify_failed",
        errorMessage: "Invalid token hash",
        errorName: "Error",
        level: "error",
      }),
    );
  });

  it("does not call the token resolver without a valid bearer header", async () => {
    const token = vi.fn(async () => "unused");
    const pepper = vi.fn(async () => "pepper");
    const { app, handler } = createApp({ token, pepper });
    for (const authorization of [
      "basic secret",
      "Bearer secret extra",
      "Bearer\t",
    ]) {
      expect(
        (await app.request("/protected", { headers: { authorization } }))
          .status,
      ).toBe(401);
    }
    expect(token).not.toHaveBeenCalled();
    expect(pepper).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not verify or log when no stored token exists", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const pepper = vi.fn(async () => "pepper");
    const { app, handler } = createApp({ token: async () => null, pepper });
    const response = await app.request(
      "/protected",
      { headers: { authorization: "Bearer secret" } },
      { LOG_LEVEL: "info" },
    );
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("Unauthorized");
    expect(pepper).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  });
});
