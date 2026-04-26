type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

type LogFields = Record<string, unknown>;

type LogEnv = {
  ENVIRONMENT?: string | undefined;
  LOG_LEVEL?: string | undefined;
};

const logLevelPriorities: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

function parseLogLevel(value: string | undefined): LogLevel | null {
  if (value === undefined) {
    return null;
  }

  switch (value.toLowerCase()) {
    case "debug":
      return "debug";
    case "info":
      return "info";
    case "warn":
      return "warn";
    case "error":
      return "error";
    case "silent":
      return "silent";
    default:
      return null;
  }
}

function getConfiguredLogLevel(env: LogEnv): LogLevel {
  return (
    parseLogLevel(env.LOG_LEVEL) ??
    (env.ENVIRONMENT === "production" ? "info" : "debug")
  );
}

function shouldLog(env: LogEnv, level: Exclude<LogLevel, "silent">): boolean {
  return (
    logLevelPriorities[level] >= logLevelPriorities[getConfiguredLogLevel(env)]
  );
}

function writeConsole(
  level: Exclude<LogLevel, "silent">,
  record: LogFields,
): void {
  switch (level) {
    case "debug":
      console.debug(record);
      return;
    case "info":
      console.info(record);
      return;
    case "warn":
      console.warn(record);
      return;
    case "error":
      console.error(record);
      return;
  }
}

function writeLog(
  env: LogEnv,
  level: Exclude<LogLevel, "silent">,
  event: string,
  fields?: LogFields,
): void {
  if (!shouldLog(env, level)) {
    return;
  }

  writeConsole(level, {
    ...fields,
    event,
    level,
  });
}

export function logInfo(env: LogEnv, event: string, fields?: LogFields): void {
  writeLog(env, "info", event, fields);
}

export function logWarn(env: LogEnv, event: string, fields?: LogFields): void {
  writeLog(env, "warn", event, fields);
}

export function logError(env: LogEnv, event: string, fields?: LogFields): void {
  writeLog(env, "error", event, fields);
}

export function createErrorLogFields(error: unknown): LogFields {
  const fields: LogFields = {};

  if (error instanceof Error) {
    fields["errorName"] = error.name;
    fields["errorMessage"] = error.message;
    if (error.stack !== undefined) {
      fields["errorStack"] = error.stack;
    }
  } else {
    fields["error"] = error;
  }

  if (typeof error === "object" && error !== null) {
    if ("kind" in error && typeof error.kind === "string") {
      fields["errorKind"] = error.kind;
    }
    if ("endpoint" in error && typeof error.endpoint === "string") {
      fields["endpoint"] = error.endpoint;
    }
    if ("statusText" in error && typeof error.statusText === "string") {
      fields["statusText"] = error.statusText;
    }
  }

  return fields;
}
