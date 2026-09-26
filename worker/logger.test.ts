import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createErrorLogFields, logError, logInfo, logWarn } from "./logger";

const output = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("structured Worker logs", () => {
  beforeEach(() => {
    for (const level of ["debug", "info", "warn", "error"] as const) {
      vi.spyOn(console, level).mockImplementation(output[level]);
      output[level].mockReset();
    }
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes structured fields through the correct console level", () => {
    const env = { LOG_LEVEL: "debug" };
    logInfo(env, "live.started", {
      userId: "u",
      level: "spoofed",
      event: "spoofed",
    });
    logWarn(env, "live.warning", { reason: "stale" });
    logError(env, "live.failed", { reason: "network" });
    expect(output.info).toHaveBeenCalledExactlyOnceWith({
      userId: "u",
      level: "info",
      event: "live.started",
    });
    expect(output.warn).toHaveBeenCalledExactlyOnceWith({
      reason: "stale",
      level: "warn",
      event: "live.warning",
    });
    expect(output.error).toHaveBeenCalledExactlyOnceWith({
      reason: "network",
      level: "error",
      event: "live.failed",
    });
    expect(output.debug).not.toHaveBeenCalled();
  });

  it.each([
    ["debug", true, true, true],
    ["info", true, true, true],
    ["warn", false, true, true],
    ["error", false, false, true],
    ["silent", false, false, false],
  ] as const)("filters at %s", (level, info, warn, error) => {
    const env = { LOG_LEVEL: level };
    logInfo(env, "info");
    logWarn(env, "warn");
    logError(env, "error");
    expect(output.info).toHaveBeenCalledTimes(Number(info));
    expect(output.warn).toHaveBeenCalledTimes(Number(warn));
    expect(output.error).toHaveBeenCalledTimes(Number(error));
  });

  it("normalizes case and falls back based on environment", () => {
    logInfo({ LOG_LEVEL: "WaRn", ENVIRONMENT: "production" }, "hidden");
    logWarn({ LOG_LEVEL: "WaRn" }, "shown");
    logInfo({ LOG_LEVEL: "unknown", ENVIRONMENT: "production" }, "prod");
    logInfo({ ENVIRONMENT: "development" }, "dev");
    expect(output.info.mock.calls.map(([record]) => record.event)).toEqual([
      "prod",
      "dev",
    ]);
    expect(output.warn).toHaveBeenCalledWith({ event: "shown", level: "warn" });
  });

  it("extracts error details and structured upstream metadata", () => {
    const error = Object.assign(new TypeError("failed"), {
      kind: "request_failed",
      endpoint: "https://upstream",
      statusText: "Bad Gateway",
    });
    const fields = createErrorLogFields(error);
    expect(fields).toEqual({
      errorName: "TypeError",
      errorMessage: "failed",
      errorStack: error.stack,
      errorKind: "request_failed",
      endpoint: "https://upstream",
      statusText: "Bad Gateway",
    });
    expect(createErrorLogFields("oops")).toEqual({ error: "oops" });
    expect(createErrorLogFields(null)).toEqual({ error: null });
    expect(
      createErrorLogFields({ kind: 42, endpoint: null, statusText: false }),
    ).toEqual({ error: { kind: 42, endpoint: null, statusText: false } });
    expect(
      createErrorLogFields({
        kind: "forbidden",
        endpoint: "url",
        statusText: "No",
      }),
    ).toEqual({
      error: { kind: "forbidden", endpoint: "url", statusText: "No" },
      errorKind: "forbidden",
      endpoint: "url",
      statusText: "No",
    });
  });
});
