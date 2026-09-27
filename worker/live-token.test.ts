import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveToken } from "./live-token";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createLiveToken", () => {
  it("returns a 32-byte token encoded as lowercase hexadecimal", () => {
    const randomValues = vi.fn<(array: Uint8Array) => Uint8Array>((array) => {
      array.fill(0xab);
      return array;
    });
    vi.stubGlobal("crypto", { getRandomValues: randomValues });

    const token = createLiveToken();

    expect(randomValues).toHaveBeenCalledTimes(1);
    expect(randomValues.mock.calls[0]?.[0]).toHaveLength(32);
    expect(token).toBe("ab".repeat(32));
    expect(token).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("encodes leading zero bytes with two hex characters", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: vi.fn<(array: Uint8Array) => Uint8Array>((array) => {
        array.fill(0);
        array[31] = 15;
        return array;
      }),
    });

    expect(createLiveToken()).toBe(`${"00".repeat(31)}0f`);
  });
});
