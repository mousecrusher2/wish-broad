import { afterEach, describe, expect, it, vi } from "vitest";
import { assert, asyncProperty, string } from "fast-check";
import { hashTokenWithPepper, verifyTokenHash } from "./token-hash";

describe("peppered token hashes", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("produces a stable SHA-256 HMAC and verifies only the matching token", async () => {
    const hash = await hashTokenWithPepper("secret-pepper", "live-token");

    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
    expect(await hashTokenWithPepper("secret-pepper", "live-token")).toBe(hash);
    await expect(
      verifyTokenHash("secret-pepper", "live-token", hash),
    ).resolves.toBe(true);
    await expect(
      verifyTokenHash("different-pepper", "live-token", hash),
    ).resolves.toBe(false);
    await expect(
      verifyTokenHash("secret-pepper", "different-token", hash),
    ).resolves.toBe(false);
  });

  it("accepts uppercased stored hashes and rejects malformed hex", async () => {
    const hash = await hashTokenWithPepper("pepper", "token");

    await expect(
      verifyTokenHash("pepper", "token", hash.toUpperCase()),
    ).resolves.toBe(true);
    await expect(verifyTokenHash("pepper", "token", "abc")).rejects.toThrow(
      "Invalid token hash",
    );
    await expect(verifyTokenHash("pepper", "token", "zz")).rejects.toThrow(
      "Invalid token hash",
    );
    await expect(verifyTokenHash("pepper", "token", "")).rejects.toThrow(
      "Invalid token hash",
    );
    await expect(
      verifyTokenHash("pepper", "token", `zz${hash.slice(2)}`),
    ).rejects.toThrow("Invalid token hash");
    await expect(
      verifyTokenHash("pepper", "token", `${hash.slice(0, -2)}zz`),
    ).rejects.toThrow("Invalid token hash");
  });

  it("imports a non-extractable HMAC key with only signing and verification usage", async () => {
    const importKey = vi.spyOn(crypto.subtle, "importKey");

    await hashTokenWithPepper("pepper", "token");

    expect(importKey).toHaveBeenCalledWith(
      "raw",
      new TextEncoder().encode("pepper"),
      { hash: "SHA-256", name: "HMAC" },
      false,
      ["sign", "verify"],
    );
  });

  it("requires a non-empty pepper when creating a hash", async () => {
    await expect(hashTokenWithPepper("", "token")).rejects.toThrow(
      "Token pepper is required",
    );
  });

  it("round-trips arbitrary non-empty peppers and tokens", async () => {
    await assert(
      asyncProperty(
        string({ minLength: 1 }),
        string(),
        async (pepper, token) => {
          const hash = await hashTokenWithPepper(pepper, token);
          expect(hash).toMatch(/^[0-9a-f]{64}$/u);
          await expect(verifyTokenHash(pepper, token, hash)).resolves.toBe(
            true,
          );
          await expect(
            verifyTokenHash(pepper, `${token}\u0000`, hash),
          ).resolves.toBe(false);
        },
      ),
      { numRuns: 25 },
    );
  });
});
