// アプリの JWT Cookie を必要とするブラウザ向け API。
import type {
  CreatedLiveToken,
  LiveSummary,
  LiveTokenStatus,
  User,
} from "../../shared/protocol";
import {
  generateTurnIceServers,
  TurnApiError,
  type TurnIceServer,
} from "../clients/turn";
import { createLiveToken } from "../lib/live-token";
import { createErrorLogFields, logError } from "../lib/logger";
import { hashTokenWithPepper } from "../lib/token-hash";
import { appJwtAuth } from "../middleware/app-jwt";
import { getLiveState } from "../state/live-state";
import { createApp } from "./create-app";

export const apiRoutes = createApp();

apiRoutes.use("/*", ...appJwtAuth("api.request"));

apiRoutes.get("/me", async (c) => {
  const jwtPayload = c.get("jwtPayload");

  return c.json({
    userId: jwtPayload.userId,
    displayName: jwtPayload.displayName,
  } satisfies User);
});

apiRoutes.get("/turn-credentials", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  let iceServers: TurnIceServer[];
  try {
    iceServers = await generateTurnIceServers(c.env, jwtPayload.userId);
  } catch (error: unknown) {
    if (!(error instanceof TurnApiError)) {
      throw error;
    }
    logError(c.env, "turn_credentials.generate_failed", {
      ...createErrorLogFields(error),
      userId: jwtPayload.userId,
    });
    return c.text(
      "Failed to generate TURN credentials",
      error.kind === "request_timeout" ? 504 : 502,
    );
  }

  c.header("Cache-Control", "no-store");
  return c.json({ iceServers });
});

// 配信トークンはいつでもローテーションできる。生のトークンは作成時にのみ返し、
// ストレージにはペッパー付き HMAC のみを保存する。
apiRoutes.post("/me/livetoken", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  const userId = jwtPayload.userId;
  const token = createLiveToken();
  const tokenHash = await hashTokenWithPepper(c.env.LIVE_TOKEN_PEPPER, token);

  try {
    await getLiveState(c.env).setLiveToken(userId, tokenHash);
  } catch (error: unknown) {
    logError(c.env, "live_token.save_failed", {
      ...createErrorLogFields(error),
      userId,
    });
    return c.text("Failed to save live token", 500);
  }

  return c.json({
    success: true,
    token,
  } satisfies CreatedLiveToken);
});

// 副作用のないトークン状態確認。既存のトークン値は決して返さない。
apiRoutes.get("/me/livetoken", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  const userId = jwtPayload.userId;
  let hasToken: boolean;
  try {
    hasToken = await getLiveState(c.env).hasLiveToken(userId);
  } catch (error: unknown) {
    logError(c.env, "live_token.status_check_failed", {
      ...createErrorLogFields(error),
      userId,
    });
    return c.text("Failed to check live token", 500);
  }

  return c.json({ hasToken } satisfies LiveTokenStatus);
});

apiRoutes.get("/lives", async (c) => {
  // 一覧を軽量に保つため SFU には問い合わせない。古い行はインジェストや再生のときに整合をとる
  // （docs/architecture.md「配信行のセマンティクス」）。
  const lives: LiveSummary[] = await getLiveState(c.env).getAllLives();
  return c.json(lives);
});
