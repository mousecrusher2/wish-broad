import { describe, expect, it } from "vitest";
import { nextPlayerLoadSequence } from "./next-player-load-sequence";

describe("nextPlayerLoadSequence", () => {
  it("returns the next monotonically increasing player load id", () => {
    expect(nextPlayerLoadSequence(1)).toBe(2);
    expect(nextPlayerLoadSequence(42)).toBe(43);
  });
});
