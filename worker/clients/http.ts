// Worker の外部 API ラッパー間で共有される fetch ヘルパー。各ラッパーは `FetchError` を
// 独自の Error サブクラスに変換してスローし、ここには重複する共通処理のみを切り出している。

type FetchErrorKind = "request_failed" | "request_timeout";

/** 応答の本文を読み切る前に、リクエストが失敗またはタイムアウトした。 */
export class FetchError extends Error {
  readonly kind: FetchErrorKind;

  constructor(kind: FetchErrorKind, cause: unknown) {
    super(
      kind === "request_timeout"
        ? "The request timed out"
        : "The request failed",
      { cause },
    );
    this.name = "FetchError";
    this.kind = kind;
  }
}

/** 本文まで読み切った応答。 */
export type FetchedResponse = {
  /** 本文のテキスト。本文がなければ空文字列。 */
  bodyText: string;
  ok: boolean;
  status: number;
  statusText: string;
};

/**
 * `endpoint` へ fetch して本文まで読み切る。`timeoutMs` ミリ秒が経過するか、`deadline` が
 * 中断されたら fetch を中断する。中断で本文の読み取りまで止まるかは実行環境に任せる。
 *
 * @throws {FetchError} 本文を読み切る前にリクエストが失敗またはタイムアウトした場合。
 * `deadline` がすでに中断されていれば、リクエストを送らずに `request_timeout` で失敗する。
 */
export async function fetchWithTimeout(
  endpoint: string,
  init: RequestInit,
  timeoutMs: number,
  deadline?: AbortSignal,
): Promise<FetchedResponse> {
  if (deadline?.aborted) {
    throw new FetchError("request_timeout", deadline.reason);
  }

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
  }, timeoutMs);
  const signal =
    deadline === undefined
      ? timeoutController.signal
      : AbortSignal.any([deadline, timeoutController.signal]);

  try {
    const response = await fetch(endpoint, { ...init, signal });
    return {
      bodyText: await response.text(),
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
    };
  } catch (error: unknown) {
    // signal を中断するのはタイムアウトと `deadline` だけで、どちらも時間切れとして扱う。
    // エラーの名前は中断した側が付けた理由で変わるため、signal の状態で判定する。
    throw new FetchError(
      signal.aborted ? "request_timeout" : "request_failed",
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
