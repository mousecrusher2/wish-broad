// Worker の外部 API ラッパー間で共有される fetch ヘルパー。各ラッパーは引き続き
// 独自の Error サブクラスをスローし、ここには重複する共通処理のみを切り出している。

export type FetchFailureKind = "request_failed" | "request_timeout";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/** 本文まで読み切った応答。 */
export type FetchedResponse = {
  /** 本文のテキスト。本文がなければ空文字列。 */
  bodyText: string;
  ok: boolean;
  status: number;
  statusText: string;
};

async function fetchAndReadBody(
  endpoint: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<FetchedResponse> {
  const response = await fetch(endpoint, { ...init, signal });
  return {
    bodyText: await response.text(),
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
  };
}

/**
 * `endpoint` へ fetch して本文まで読み切る。本文を読み切らないまま `timeoutMs` ミリ秒が
 * 経過したら中断する。
 *
 * @throws {Error} 本文を読み切る前にリクエストが失敗またはタイムアウトした場合、`createError` が構築したエラー。
 */
export async function fetchWithTimeout(
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
  createError: (kind: FetchFailureKind, cause: unknown) => Error,
): Promise<FetchedResponse> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => {
    abortController.abort();
  }, timeoutMs);
  // 中断が本文の読み取りまで止めるかは実行環境に任せず、中断した時点で必ず抜ける。
  const aborted = new Promise<never>((_resolve, reject) => {
    abortController.signal.addEventListener(
      "abort",
      () => {
        reject(new DOMException("The request timed out", "AbortError"));
      },
      { once: true },
    );
  });

  try {
    return await Promise.race([
      fetchAndReadBody(endpoint, init, abortController.signal),
      aborted,
    ]);
  } catch (error: unknown) {
    // 呼び出し元からは独自の signal を渡さないため、abort はタイムアウト発火を意味する。
    throw createError(
      isAbortError(error) ? "request_timeout" : "request_failed",
      error,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/** 本文が JSON であればパース済み JSON、それ以外は生テキスト、空なら null を返す。 */
export function parseResponseBody(bodyText: string): unknown {
  if (bodyText.length === 0) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(bodyText);
    return parsed;
  } catch {
    return bodyText;
  }
}

/** 連続する空白文字を 1 つにまとめ、ログ記録用にボディの先頭部分のみを保持する。 */
export function trimResponseBody(text: string): string | undefined {
  const normalized = text.replaceAll(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.slice(0, 200);
}
