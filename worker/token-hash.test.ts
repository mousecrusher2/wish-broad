import { afterEach, describe, expect, it, vi } from "vitest";
// oxlint-disable no-await-in-loop -- Check each malformed hash separately.
import { hashTokenWithPepper, verifyTokenHash } from "./token-hash";

describe("token hashing", () => {
  afterEach(() => vi.restoreAllMocks());

  it("computes a lowercase HMAC-SHA256 digest with the pepper as the key", async () => {
    // Cross checked against the published HMAC-SHA256 test vector from RFC 4231.
    const digest = await hashTokenWithPepper(
      "Jefe",
      "what do ya want for nothing?",
    );
    expect(digest).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
    expect(
      await verifyTokenHash("Jefe", "what do ya want for nothing?", digest),
    ).toBe(true);
    expect(await verifyTokenHash("Jefe", "wrong", digest)).toBe(false);
    expect(
      await verifyTokenHash("wrong", "what do ya want for nothing?", digest),
    ).toBe(false);
    expect(
      await verifyTokenHash(
        "Jefe",
        "what do ya want for nothing?",
        digest.toUpperCase(),
      ),
    ).toBe(true);
  });

  it("rejects an empty pepper and malformed stored hashes", async () => {
    await expect(hashTokenWithPepper("", "token")).rejects.toThrow(
      "Token pepper is required",
    );
    for (const malformed of [
      "a",
      "zz",
      "0g",
      "f".repeat(63),
      "f".repeat(65),
      "f".repeat(64) + "!",
      "!" + "f".repeat(64),
      "!!" + "f".repeat(64),
    ]) {
      await expect(
        verifyTokenHash("pepper", "token", malformed),
      ).rejects.toThrow("Invalid token hash");
    }
  });

  it("imports the pepper as a non-extractable HMAC key", async () => {
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
});
