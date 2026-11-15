// Worker の外部 API ラッパー間で共有される fetch ヘルパー。各ラッパーは引き続き
// 独自の Error サブクラスをスローし、ここには重複する共通処理のみを切り出している。

export type FetchFailureKind = "request_failed" | "request_timeout";

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * 応答のないまま `timeoutMs` ミリ秒が経過したら中断する条件付きで `endpoint` へ fetch する。
 *
 * @throws {Error} 応答到着前にリクエストが失敗またはタイムアウトした場合、`createError` が構築したエラー。
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
    // 呼び出し元からは独自の signal を渡さないため、abort はタイムアウト発火を意味する。
    throw createError(
      isAbortError(error) ? "request_timeout" : "request_failed",
      error,
    );
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * レスポンスボディを 1 度だけ読み取り、JSON であればパース済み JSON、それ以外は生テキスト、
 * 空または読み取れない場合は null を返す。先に `json()` で読むとボディが消費されてしまい、
 * 非 JSON ボディをテキストとして読み直せなくなるためこの方式をとっている。
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

/** 連続する空白文字を 1 つにまとめ、ログ記録用にボディの先頭部分のみを保持する。 */
export function trimResponseBody(text: string): string | undefined {
  const normalized = text.replaceAll(/\s+/gu, " ").trim();
  if (normalized.length === 0) {
    return undefined;
  }

  return normalized.slice(0, 200);
}
