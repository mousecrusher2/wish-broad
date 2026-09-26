import { afterEach, describe, expect, it, vi } from "vitest";
import { calcJwtTimestamps, JWT_DURATION_SECONDS } from "./jwt-utils";

describe("JWT timestamps", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses whole Unix seconds and adds the specified duration", () => {
    vi.spyOn(Date, "now").mockReturnValue(1_700_000_123_987);
    expect(calcJwtTimestamps(17)).toEqual({
      iat: 1_700_000_123,
      exp: 1_700_000_140,
    });
    expect(calcJwtTimestamps()).toEqual({
      iat: 1_700_000_123,
      exp: 1_700_086_523,
    });
  });

  it("defines exact durations in seconds", () => {
    expect(JWT_DURATION_SECONDS).toEqual({
      ONE_HOUR: 3_600,
      ONE_DAY: 86_400,
      ONE_WEEK: 604_800,
      ONE_MONTH: 2_592_000,
    });
  });
});
