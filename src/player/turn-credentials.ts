import * as v from "valibot";

const turnIceServerSchema = v.object({
  credential: v.optional(v.string()),
  urls: v.union([v.string(), v.array(v.string())]),
  username: v.optional(v.string()),
});

const turnCredentialsResponseSchema = v.object({
  iceServers: v.array(turnIceServerSchema),
});

/**
 * 認証済みの `/api/turn-credentials` から ICE サーバーを取得する。汎用 WHEP の OPTIONS/Link
 * 探索は使わない（docs/architecture.md「WHEPクライアントの設計判断」）。取得できなかった場合は
 * ログ出力して null を返し、呼び出し側は TURN なしで接続する。
 *
 * @throws {Error} `signal` が中断された場合（AbortError）。
 */
export async function fetchTurnIceServers(
  signal: AbortSignal,
): Promise<RTCIceServer[] | null> {
  const response = await fetch("/api/turn-credentials", {
    credentials: "include",
    headers: {
      Accept: "application/json",
    },
    signal,
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "AbortError") {
      throw error;
    }

    console.warn("Failed to fetch TURN credentials:", error);
    return null;
  });
  if (response === null) {
    return null;
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => undefined);
    console.warn("TURN credential request failed:", {
      responseText,
      status: response.status,
      statusText: response.statusText,
    });
    return null;
  }

  const responseBody: unknown = await response
    .json()
    .then((value: unknown) => value)
    .catch((error: Error | SyntaxError) => {
      console.warn("TURN credential response was not valid JSON:", error);
      return null;
    });
  if (responseBody === null) {
    return null;
  }

  const parsedResponse = v.safeParse(
    turnCredentialsResponseSchema,
    responseBody,
  );
  if (!parsedResponse.success) {
    console.warn("TURN credential response schema was invalid:", {
      issues: parsedResponse.issues,
      responseBody,
    });
    return null;
  }

  if (parsedResponse.output.iceServers.length === 0) {
    console.warn("TURN credential response did not contain any ICE servers");
    return null;
  }

  return parsedResponse.output.iceServers.map((iceServer) => {
    const normalizedIceServer: RTCIceServer = {
      urls: iceServer.urls,
    };
    if (iceServer.credential) {
      normalizedIceServer.credential = iceServer.credential;
    }
    if (iceServer.username) {
      normalizedIceServer.username = iceServer.username;
    }
    return normalizedIceServer;
  });
}
