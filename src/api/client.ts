// 同一オリジンの Worker API へのリクエストと、そのレスポンスの検証。
import * as v from "valibot";
import type {
  CreatedLiveToken,
  LiveSummary,
  LiveTokenStatus,
  User,
} from "../../shared/protocol";

// 各スキーマの出力が Worker との取り決めの型に代入できることを satisfies で確かめる。
const userSchema = v.object({
  userId: v.string(),
  displayName: v.string(),
}) satisfies v.GenericSchema<unknown, User>;
const liveSchema = v.object({
  owner: userSchema,
}) satisfies v.GenericSchema<unknown, LiveSummary>;
const liveListSchema = v.array(liveSchema);
const liveTokenResponseSchema = v.object({
  hasToken: v.boolean(),
}) satisfies v.GenericSchema<unknown, LiveTokenStatus>;
const createTokenResponseSchema = v.object({
  success: v.literal(true),
  token: v.string(),
}) satisfies v.GenericSchema<unknown, CreatedLiveToken>;

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

/**
 * アプリの Cookie を付与して同一オリジンの API にリクエストを送信する。
 *
 * @throws {UnauthorizedError} API が 401 を返した場合。
 * @throws {TypeError} レスポンス到着前にリクエストが失敗した場合。
 */
async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, {
    ...init,
    credentials: "include",
  });
  if (response.status === 401) {
    throw new UnauthorizedError();
  }

  return response;
}

/**
 * JSON レスポンスボディを読み取り、`schema` に対して検証する。
 *
 * @throws {SyntaxError} ボディが有効な JSON でない場合。
 * @throws {Error} ボディが `schema` に一致しない場合（エラーメッセージは `invalidMessage`）。
 */
async function readJson<TOutput>(
  response: Response,
  schema: v.GenericSchema<unknown, TOutput>,
  invalidMessage: string,
): Promise<TOutput> {
  const parsed = v.safeParse(schema, await response.json());
  if (!parsed.success) {
    throw new Error(invalidMessage);
  }

  return parsed.output;
}

/**
 * @throws {UnauthorizedError} セッション Cookie が未設定または期限切れの場合。
 * @throws {Error} リクエストに失敗したか、レスポンスがユーザー情報でない場合。
 */
export async function fetchCurrentUser(): Promise<User> {
  const response = await apiFetch("/api/me");
  if (!response.ok) {
    throw new Error(`Unexpected status code: ${String(response.status)}`);
  }

  return readJson(response, userSchema, "Unexpected /api/me response");
}

/**
 * @throws {UnauthorizedError} セッション Cookie が未設定または期限切れの場合。
 * @throws {Error} リクエストに失敗したか、レスポンスが配信一覧でない場合。
 */
export async function fetchLiveStreams(): Promise<LiveSummary[]> {
  const response = await apiFetch("/api/lives");
  if (!response.ok) {
    throw new Error("配信リストの取得に失敗しました");
  }

  return readJson(response, liveListSchema, "Unexpected live streams response");
}

/**
 * @throws {UnauthorizedError} セッション Cookie が未設定または期限切れの場合。
 * @throws {Error} リクエストに失敗したか、レスポンスがトークンステータスでない場合。
 */
export async function fetchLiveTokenStatus(): Promise<LiveTokenStatus> {
  const response = await apiFetch("/api/me/livetoken", {
    method: "GET",
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${String(response.status)}`);
  }

  return readJson(
    response,
    liveTokenResponseSchema,
    "Unexpected live token response",
  );
}

/**
 * 新しい配信トークンを発行して返す。
 *
 * @throws {UnauthorizedError} セッション Cookie が未設定または期限切れの場合。
 * @throws {Error} リクエストに失敗したか、レスポンスが新規トークンでない場合。
 */
export async function createLiveToken(): Promise<string> {
  const response = await apiFetch("/api/me/livetoken", {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${String(response.status)}`);
  }

  const { token } = await readJson(
    response,
    createTokenResponseSchema,
    "Unexpected token creation response",
  );
  return token;
}
