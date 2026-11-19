import { describe, expect, it } from "vitest";
import {
  signPlaySession,
  verifyPlaySessionSignature,
} from "./play-session-signature";

describe("play session signatures", () => {
  it("verifies only the session and viewer the signature was made for", async () => {
    const signature = await signPlaySession("secret", "session-1", "viewer-1");

    expect(signature).toMatch(/^[0-9a-f]{64}$/u);
    await expect(
      verifyPlaySessionSignature("secret", "session-1", "viewer-1", signature),
    ).resolves.toBe(true);
    await expect(
      verifyPlaySessionSignature(
        "secret",
        "session-1",
        "viewer-1",
        signature.toUpperCase(),
      ),
    ).resolves.toBe(true);
    await expect(
      verifyPlaySessionSignature("secret", "session-2", "viewer-1", signature),
    ).resolves.toBe(false);
    await expect(
      verifyPlaySessionSignature("secret", "session-1", "viewer-2", signature),
    ).resolves.toBe(false);
    await expect(
      verifyPlaySessionSignature("other", "session-1", "viewer-1", signature),
    ).resolves.toBe(false);
  });

  it("keeps fields that contain the separator apart", async () => {
    const signature = await signPlaySession("secret", "a:b", "c");

    await expect(
      verifyPlaySessionSignature("secret", "a", "b:c", signature),
    ).resolves.toBe(false);
  });

  it.each(["", "abc", "zz", "not-hex"])(
    "rejects the malformed signature %j",
    async (signature) => {
      await expect(
        verifyPlaySessionSignature(
          "secret",
          "session-1",
          "viewer-1",
          signature,
        ),
      ).resolves.toBe(false);
    },
  );

  it("requires a signing key", async () => {
    await expect(signPlaySession("", "session-1", "viewer-1")).rejects.toThrow(
      "Play session signing key is required",
    );
    await expect(
      verifyPlaySessionSignature("", "session-1", "viewer-1", "00"),
    ).rejects.toThrow("Play session signing key is required");
  });
});
