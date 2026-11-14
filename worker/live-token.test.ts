import { describe, expect, it, vi } from "vitest";
import { createLiveToken } from "./live-token";

// 乱数源だけを差し替え、指定したバイト列で配列を埋めさせる。
function mockRandomBytes(fill: (bytes: Uint8Array) => void) {
  return vi.spyOn(crypto, "getRandomValues").mockImplementation((array) => {
    fill(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return array;
  });
}

describe("createLiveToken", () => {
  it("returns a 32-byte token encoded as lowercase hexadecimal", () => {
    const randomValues = mockRandomBytes((bytes) => {
      bytes.fill(0xab);
    });

    const token = createLiveToken();

    expect(randomValues).toHaveBeenCalledOnce();
    expect(randomValues.mock.calls[0]?.[0]).toHaveLength(32);
    expect(token).toBe("ab".repeat(32));
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("encodes leading zero bytes with two hex characters", () => {
    mockRandomBytes((bytes) => {
      bytes.fill(0);
      bytes[31] = 15;
    });

    expect(createLiveToken()).toBe(`${"00".repeat(31)}0f`);
  });
});
