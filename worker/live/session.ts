// 配信行が保持するインジェストセッションの生死の判定と、DELETE なしで失われたセッションの扱い。
// 判定の各分岐と以下の値の根拠は docs/architecture.md の「インジェストのライフサイクル」を参照。
import type { LiveRecord } from "./types";
import { getLiveState } from "../state/live-state";
import { createErrorLogFields, logInfo, logWarn } from "../lib/logger";
import { isSessionActive } from "../clients/sfu";
import type { Bindings } from "../types";

/** リクエストがセッションの生存確認時刻を記録する最小間隔。 */
const LIVE_SESSION_SEEN_ACTIVE_WRITE_INTERVAL_MS = 10_000;
/** 最後の生存確認からこの時間以内に失われたセッションは、たった今失われたとみなす。 */
const LIVE_SESSION_RECENTLY_ACTIVE_MS = 60_000;
/** たった今失われたセッションの配信に与える再接続猶予期間。 */
const LIVE_LOST_SESSION_GRACE_MS = 30_000;

/**
 * 配信行が保持するインジェストセッションの状態。
 *
 * - `reconnect_grace`: DELETE 後の再接続猶予期間中で、保存済みトラックはすでに閉じられている。
 * - `active`: SFU 上でまだアクティブ。
 * - `recently_lost`: SFU 上では非アクティブだが、直前までアクティブが確認されていた。
 * - `lost`: SFU 上で非アクティブで、直近のアクティブ確認もない。
 */
export type LiveSessionStatus =
  "reconnect_grace" | "active" | "recently_lost" | "lost";

function wasSessionSeenActiveRecently(live: LiveRecord, now: number): boolean {
  return (
    live.sessionSeenActiveAt !== null &&
    now - live.sessionSeenActiveAt <= LIVE_SESSION_RECENTLY_ACTIVE_MS
  );
}

/**
 * リクエストがセッションの生存を確認したことを waitUntil 内で LiveState に記録する。
 * ベストエフォートであり、失敗はログ出力する。
 */
function recordLiveSessionSeenActive(
  env: Bindings,
  ctx: Pick<ExecutionContext, "waitUntil">,
  live: LiveRecord,
  now: number,
): void {
  // 記録が新しければ LiveState の呼び出し自体を省き、健全な配信の視聴者が
  // オブジェクトを起こさないようにする。
  if (
    live.sessionSeenActiveAt !== null &&
    now - live.sessionSeenActiveAt < LIVE_SESSION_SEEN_ACTIVE_WRITE_INTERVAL_MS
  ) {
    return;
  }

  ctx.waitUntil(
    getLiveState(env)
      .markLiveSessionSeenActive(
        live.userId,
        live.sessionId,
        LIVE_SESSION_SEEN_ACTIVE_WRITE_INTERVAL_MS,
      )
      .catch((error: unknown) => {
        logWarn(env, "live.session_activity_record_failed", {
          ...createErrorLogFields(error),
          sessionId: live.sessionId,
          userId: live.userId,
        });
      }),
  );
}

/**
 * 配信行が保持するインジェストセッションの状態を判定する。猶予期間中でなければ SFU に
 * 問い合わせ、アクティブだった場合はその確認を waitUntil 内で LiveState に記録する。
 * SFU への問い合わせは `deadline` が中断された時点で打ち切る。
 *
 * @throws {SfuApiError} SFU がセッションの状態を返せなかった場合（`deadline` による打ち切りを含む）。
 */
export async function checkLiveSession(
  env: Bindings,
  ctx: Pick<ExecutionContext, "waitUntil">,
  live: LiveRecord,
  deadline?: AbortSignal,
): Promise<LiveSessionStatus> {
  // 猶予期間が過ぎた配信は LiveState によってすでに終了されているため、猶予期限が
  // 保存されていれば必ずまだ猶予期間内である。
  if (live.graceExpiresAt !== null) {
    return "reconnect_grace";
  }

  const now = Date.now();
  if (await isSessionActive(env, live.sessionId, deadline)) {
    recordLiveSessionSeenActive(env, ctx, live, now);
    return "active";
  }

  return wasSessionSeenActiveRecently(live, now) ? "recently_lost" : "lost";
}

/**
 * DELETE なしでたった今失われたセッションの配信に、遅延した DELETE と同様の短い再接続猶予を与える。
 * その間に行が更新されていた（DELETE や再開があった）場合は何もしない。
 */
export async function startLostSessionGrace(
  env: Bindings,
  live: LiveRecord,
): Promise<void> {
  const graceExpiresAt = await getLiveState(env).startLiveReconnectGrace(
    live.userId,
    live.sessionId,
    LIVE_LOST_SESSION_GRACE_MS,
  );
  if (graceExpiresAt === null) {
    return;
  }

  logInfo(env, "live.session_lost", {
    graceExpiresAt,
    sessionId: live.sessionId,
    userId: live.userId,
  });
}
