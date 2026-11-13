// Fetch helpers shared by the Worker's external API wrappers. Each wrapper
// still throws its own Error subclass; these only remove the copied plumbing.

export type FetchFailureKind = "request_failed" | "request_timeout";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Fetch `endpoint`, aborting the request once `timeoutMs` passes without a
 * response.
 *
 * @throws {Error} The error `createError` builds when the request fails or
 * times out before a response arrives.
 */
export async function fetchWithTimeout(
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
  createError: (kind: FetchFailureKind, cause: unknown) => Error,
): Promise<Response> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);

  try {
    return await fetch(endpoint, {
      ...init,
      signal: abortController.signal,
    });
  } catch (error: unknown) {
    // Callers pass no signal of their own, so an abort means the timeout fired.
    throw createError(
      isAbortError(error) ? "request_timeout" : "request_failed",
      error,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Reads a response body once and returns it as parsed JSON when it is JSON,
 * as the raw text otherwise, or null when it is empty or cannot be read.
 * Reading with `json()` first would consume the body, so a non-JSON body
 * could no longer be read as text.
 */
export async function readResponseBody(response: Response): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return text;
  }
}

/** Collapses whitespace and keeps a short prefix of a body for logs. */
export function trimResponseBody(text: string): string | undefined {
  const normalized = text.replaceAll(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.slice(0, 200);
}
