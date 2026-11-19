import { describe, expect, it } from "vitest";
import { bytesToHex, createRandomHex, hexToBytes } from "./hex";

describe("bytesToHex", () => {
  it("encodes every byte as two lowercase hex characters", () => {
    expect(bytesToHex(Uint8Array.from([0, 15, 16, 171, 255]))).toBe(
      "000f10abff",
    );
  });
});

describe("hexToBytes", () => {
  it("decodes hex in either case back to the bytes", () => {
    expect(hexToBytes("000f10ABff")).toEqual(
      Uint8Array.from([0, 15, 16, 171, 255]),
    );
  });

  it.each(["", "abc", "zz", "0x00"])("returns null for %j", (hex) => {
    expect(hexToBytes(hex)).toBeNull();
  });
});

describe("createRandomHex", () => {
  it("returns two hex characters per random byte", () => {
    const value = createRandomHex(32);

    expect(value).toMatch(/^[0-9a-f]{64}$/u);
    expect(createRandomHex(32)).not.toBe(value);
  });
});
