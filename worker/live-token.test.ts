import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveToken } from "./live-token";

describe("createLiveToken", () => {
  afterEach(() => vi.restoreAllMocks());

  it("fills all 32 random bytes and preserves leading zeros in the hex encoding", () => {
    const random = vi
      .spyOn(crypto, "getRandomValues")
      .mockImplementation((bytes) => {
        expect(bytes).toHaveLength(32);
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      });

    expect(createLiveToken()).toBe(
      Array.from({ length: 32 }, (_, index) =>
        index.toString(16).padStart(2, "0"),
      ).join(""),
    );
    expect(random).toHaveBeenCalledOnce();
  });
});
