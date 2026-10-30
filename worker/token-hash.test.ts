import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("requires a non-empty pepper when creating a hash", async () => {
    await expect(hashTokenWithPepper("", "token")).rejects.toThrow(
      "Token pepper is required",
    );
  });
});
