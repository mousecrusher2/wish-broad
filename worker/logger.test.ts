import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createErrorLogFields,
  logDebug,
  logError,
  logInfo,
  logWarn,
} from "./logger";

describe("structured Worker logger", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes structured info, warning, and error records", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    logInfo({}, "request.completed", { requestId: "req-1" });
    logWarn({}, "request.slow", { durationMs: 500 });
    logError({}, "request.failed", { status: 500 });

    expect(info).toHaveBeenCalledWith({
      event: "request.completed",
      level: "info",
      requestId: "req-1",
    });
    expect(warn).toHaveBeenCalledWith({
      durationMs: 500,
      event: "request.slow",
      level: "warn",
    });
    expect(error).toHaveBeenCalledWith({
      event: "request.failed",
      level: "error",
      status: 500,
    });
  });

  it.each([
    ["debug", true],
    ["info", false],
    ["warn", false],
    ["error", false],
    ["silent", false],
  ] as const)(
    "honors the %s threshold for debug records",
    (level, isLogged) => {
      const debug = vi
        .spyOn(console, "debug")
        .mockImplementation(() => undefined);

      logDebug({ LOG_LEVEL: level }, "debug.event");

      expect(debug).toHaveBeenCalledTimes(isLogged ? 1 : 0);
    },
  );

  it.each([
    ["debug", true, true],
    ["info", true, true],
    ["warn", false, true],
    ["error", false, false],
    ["silent", false, false],
  ] as const)(
    "honors the %s threshold for info and warning records",
    (level, infoIsLogged, warnIsLogged) => {
      const info = vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined);
      const warn = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      logInfo({ LOG_LEVEL: level }, "info.event");
      logWarn({ LOG_LEVEL: level }, "warn.event");

      expect(info).toHaveBeenCalledTimes(infoIsLogged ? 1 : 0);
      expect(warn).toHaveBeenCalledTimes(warnIsLogged ? 1 : 0);
    },
  );

  it("parses configured levels case-insensitively and falls back for unknown values", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    logInfo({ LOG_LEVEL: "WARN" }, "hidden.info");
    logWarn({ LOG_LEVEL: "WARN" }, "shown.warn");
    logInfo(
      { ENVIRONMENT: "production", LOG_LEVEL: "invalid" },
      "fallback.info",
    );

    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith({
      event: "fallback.info",
      level: "info",
    });
    expect(warn).toHaveBeenCalledWith({ event: "shown.warn", level: "warn" });
  });

  it("uses the environment default for invalid or missing log levels", () => {
    const debug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logDebug({ LOG_LEVEL: "invalid" }, "development.default");
    logDebug(
      { ENVIRONMENT: "production", LOG_LEVEL: "invalid" },
      "production.hidden",
    );
    logDebug({ ENVIRONMENT: "production" }, "production.default");
    logInfo({ ENVIRONMENT: "production" }, "production.info");

    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledWith({
      event: "development.default",
      level: "debug",
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith({
      event: "production.info",
      level: "info",
    });
  });

  it("honors the explicit debug level in production and parses it case-insensitively", () => {
    const debug = vi
      .spyOn(console, "debug")
      .mockImplementation(() => undefined);

    logDebug({ ENVIRONMENT: "production", LOG_LEVEL: "DEBUG" }, "debug.on");

    expect(debug).toHaveBeenCalledWith({ event: "debug.on", level: "debug" });
  });

  it("keeps canonical event and level fields after caller fields", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logInfo({}, "canonical.event", { event: "wrong", level: "wrong" });

    expect(info).toHaveBeenCalledWith({
      event: "canonical.event",
      level: "info",
    });
  });

  it("extracts standard and structured fields from errors", () => {
    const error = Object.assign(new Error("failed"), {
      endpoint: "/api/live",
      kind: "http_error",
      statusText: "Bad Gateway",
    });

    expect(createErrorLogFields(error)).toEqual({
      endpoint: "/api/live",
      errorKind: "http_error",
      errorMessage: "failed",
      errorName: "Error",
      errorStack: error.stack,
      statusText: "Bad Gateway",
    });
  });

  it("omits a missing Error stack while retaining its other fields", () => {
    const error = new Error("stackless");
    Object.defineProperty(error, "stack", {
      configurable: true,
      value: undefined,
    });

    expect(createErrorLogFields(error)).toStrictEqual({
      errorMessage: "stackless",
      errorName: "Error",
    });
  });

  it.each(["plain failure", 42, false, null, undefined])(
    "preserves non-Error values in the error field (%s)",
    (value) => {
      expect(createErrorLogFields(value)).toEqual({ error: value });
    },
  );

  it("ignores structured error properties with non-string values", () => {
    const value = { endpoint: 42, kind: null, statusText: false };

    expect(createErrorLogFields(value)).toEqual({ error: value });
  });
});
