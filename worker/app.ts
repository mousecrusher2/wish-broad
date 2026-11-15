// エラーハンドラーの登録とルートの組み立てだけを行う。各ルートの処理は ./routes にある。
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { createErrorLogFields, logError } from "./lib/logger";
import { apiRoutes } from "./routes/api";
import { authRoutes } from "./routes/auth";
import { createApp } from "./routes/create-app";
import { ingestRoutes } from "./routes/ingest";
import { playRoutes } from "./routes/play";
import type { AppEnv } from "./types";

const app = createApp();

function toErrorResponse(err: unknown, c: Context<AppEnv>): Response {
  if (err instanceof HTTPException) {
    return err.getResponse();
  }

  return c.text("Internal Server Error", 500);
}

app.onError((err, c) => {
  if (!(err instanceof HTTPException)) {
    logError(c.env, "worker.unhandled_error", createErrorLogFields(err));
  }

  return toErrorResponse(err, c);
});

app.route("/ingest", ingestRoutes);
app.route("/", authRoutes);
app.route("/play", playRoutes);
app.route("/api", apiRoutes);

export default app;
