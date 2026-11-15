import { closeTracks, SfuApiError } from "../clients/sfu";
import { createErrorLogFields, logWarn } from "../lib/logger";
import type { Bindings } from "../types";

/**
 * SFU セッションの `mids` のトラックを waitUntil 内で閉じる。クリーンアップにすぎないため、
 * 失敗はログ出力だけで済ませる（配信行はすでに更新済みで、無効なトラックロケーターが
 * 公開され続けることはない）。
 */
export function closeTracksInBackground(
  env: Bindings,
  ctx: Pick<ExecutionContext, "waitUntil">,
  sessionId: string,
  mids: readonly string[],
  labels: { failure: string; error: string },
): void {
  ctx.waitUntil(
    closeTracks(env, sessionId, mids).then(
      (response) => {
        if (
          response.errorCode ||
          response.tracks?.some((track) => track.errorCode)
        ) {
          logWarn(env, "track_close.sfu_errors", {
            message: labels.error,
            response,
            sessionId,
          });
        }
      },
      (error: unknown) => {
        if (
          error instanceof SfuApiError &&
          (error.kind === "session_not_found" || error.kind === "session_gone")
        ) {
          return;
        }
        logWarn(env, "track_close.failed", {
          ...createErrorLogFields(error),
          message: labels.failure,
          sessionId,
        });
      },
    ),
  );
}
