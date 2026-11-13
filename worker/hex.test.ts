import { describe, expect, it } from "vitest";
import { bytesToHex, createRandomHex } from "./hex";

describe("bytesToHex", () => {
  it("encodes every byte as two lowercase hex characters", () => {
    expect(bytesToHex(Uint8Array.from([0, 15, 16, 171, 255]))).toBe(
      "000f10abff",
    );
  });
});

describe("createRandomHex", () => {
  it("returns two hex characters per random byte", () => {
    const value = createRandomHex(32);

    expect(value).toMatch(/^[0-9a-f]{64}$/u);
    expect(createRandomHex(32)).not.toBe(value);
  });
});
