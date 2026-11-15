import { afterEach, describe, expect, it, vi } from "vitest";
import { calcJwtTimestamps } from "./jwt-utils";

describe("JWT timestamp utilities", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses whole Unix seconds and defaults to one day", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_234_567));

    expect(calcJwtTimestamps()).toEqual({ iat: 1234, exp: 1234 + 86_400 });
  });

  it("adds the requested duration without changing the issued-at time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_234_999));

    expect(calcJwtTimestamps(0)).toEqual({ iat: 1234, exp: 1234 });
    expect(calcJwtTimestamps(-10)).toEqual({ iat: 1234, exp: 1224 });
  });
});
