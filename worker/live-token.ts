import { createRandomHex } from "./hex";

export function createLiveToken(): string {
  return createRandomHex(32);
}
