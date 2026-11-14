import type { Context } from "hono";
import { HonoBase } from "hono/hono-base";
import { LinearRouter } from "hono/router/linear-router";
import { JWTPayload, Bindings } from "./types";
import type { LiveRecord } from "./database";
import {
  clearAuthCookie,
  completeDiscordLogin,
  startDiscordLogin,
} from "./discord-login";
import {
  type IngestSession,
  type PlaybackSession,
  SfuApiError,
  type StoredTrack,
  closeTracks,
  isSessionActive,
  renegotiateSession,
  startIngest,
  startPlay,
  LiveNotFoundError,
} from "./sfu";
import { createLiveToken } from "./live-token";
import { hashedBearerAuth } from "./hashed-bearer-auth";
import { HTTPException } from "hono/http-exception";
import { jwt } from "hono/jwt";
import { csrf } from "hono/csrf";
import {
  deleteLiveStartedNotification,
  sendLiveStartedNotification,
} from "./notifications";
import { hashTokenWithPepper } from "./token-hash";
import {
  generateTurnIceServers,
  TurnApiError,
  type TurnIceServer,
} from "./turn";
import { createErrorLogFields, logError, logInfo, logWarn } from "./logger";
import { LIVE_RECONNECT_GRACE_MS } from "./live-end";
import { getLiveState, isTransientLiveStateError } from "./live-state";

type AppEnv = {
  Bindings: Bindings;
  Variables: {
    jwtPayload: JWTPayload;
  };
};

// プレーヤー側の固定再接続間隔と一致させている。
const LIVE_RECONNECTING_RETRY_AFTER_SECONDS = 2;

// OBS はクラッシュやネットワーク切断などで DELETE を送らずにインジェストセッションを
// 失う場合があり、Calls は約 30 秒後にそのセッションをガベージコレクションする。
// セッションの生存を確認したリクエストは最大この間隔で時刻を記録し、後から
// ガベージコレクション済みと判明した際に配信者が失われたのが直前かずっと前かを判定できるようにする。
const LIVE_SESSION_SEEN_ACTIVE_WRITE_INTERVAL_MS = 10_000;
// 最後に生存確認されてからこの時間以内にガベージコレクションされたセッションは
// 直前に失われたとみなす。DELETE 後の猶予期間と一致しており、OBS の伸長する再接続間隔と
// 上記の書き込み間隔の両方をカバーする。
const LIVE_SESSION_RECENTLY_ACTIVE_MS = 60_000;
// Calls はセッションをガベージコレクションする前にすでに約 30 秒待機しているため、
// この値によって配信の保持期間は DELETE 後の猶予期間とほぼ同じ長さになる。
const LIVE_LOST_SESSION_GRACE_MS = 30_000;

// 一時的な理由で失敗した際に、開始通知の保存を最大この回数まで試行する。
// 永続化が最後まで成功しなかった場合に waitUntil 内でメッセージを削除する時間を残すため、
// 各試行に対するランタイム側の自動リトライ間隔は短く保つ。
const NOTIFICATION_PERSIST_MAX_ATTEMPTS = 2;
const NOTIFICATION_PERSIST_RETRY_DELAY_MS = 500;
const NOTIFICATION_PERSIST_RPC_RETRY = {
  maxRetries: 1,
  timeoutMs: 5_000,
};

const app = new HonoBase<AppEnv>({ router: new LinearRouter() });

function createPlaySessionLocation(
  requestUrl: string,
  userId: string,
  sessionId: string,
  tracks: StoredTrack[],
): string {
  const origin = new URL(requestUrl).origin;
  const sessionUrl = new URL(
    `/play/${encodeURIComponent(userId)}/${encodeURIComponent(sessionId)}`,
    origin,
  );

  for (const track of tracks) {
    sessionUrl.searchParams.append("mid", track.mid);
  }

  return sessionUrl.toString();
}

function createSiteRootLocation(requestUrl: string): string {
  return new URL("/", requestUrl).toString();
}

function getRequestedTrackMids(requestUrl: string): string[] {
  const mids = new URL(requestUrl).searchParams.getAll("mid");
  const normalizedMids = mids.flatMap((mid) => {
    const trimmedMid = mid.trim();
    return trimmedMid ? [trimmedMid] : [];
  });
  return [...new Set(normalizedMids)];
}

// Calls のセッション ID は不透明（opaque）な URL セーフ文字列である。WHEP セッション
// ルートはデコード済みのパスパラメーターを Calls API の URL に埋め込むため、
// デコード後の "/" や "?" など URL を書き換えてしまいうる値は拒否する。
function isCallsSessionId(sessionId: string): boolean {
  return /^[0-9A-Za-z_-]+$/u.test(sessionId);
}

function createWhepCloseTracks(
  sessionId: string,
  mids: string[],
): StoredTrack[] {
  return mids.map((mid) => ({
    location: "remote",
    mid,
    sessionId,
    trackName: mid,
  }));
}

function scheduleTrackClose(
  c: Context<AppEnv>,
  sessionId: string,
  tracks: StoredTrack[],
  failureLabel: string,
  errorLabel: string,
): void {
  // トラックのクローズはクリーンアップ目的にすぎない。この処理が走る時点で配信行は
  // すでに更新済みのため、Calls の一時的な失敗によって無効なトラックロケーターが
  // 公開され続けることはない。
  c.executionCtx.waitUntil(
    closeTracks(c.env, sessionId, tracks).then(
      (response) => {
        if (
          response.errorCode ||
          response.tracks?.some((track) => track.errorCode)
        ) {
          logWarn(c.env, "track_close.sfu_errors", {
            message: errorLabel,
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
        logWarn(c.env, "track_close.failed", {
          ...createErrorLogFields(error),
          message: failureLabel,
          sessionId,
        });
      },
    ),
  );
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

// 開始通知を LiveState に報告する。LiveState は配信にメッセージ ID を保存するか、
// 配信がすでに終了している場合は削除キューへ直接追加する。LiveState に報告できなかった
// 場合は理由をログ出力したうえで false を返す。
async function persistLiveStartNotification(
  c: Context<AppEnv>,
  userId: string,
  broadcastId: string,
  sessionId: string,
  messageId: string,
): Promise<boolean> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // 失敗した呼び出しはスタブを壊れた状態に残す場合があるため、試行ごとに新しいスタブを取得する。
      // 同じ ID を再保存するだけなので再実行しても安全。
      // oxlint-disable-next-line no-await-in-loop -- 前回の失敗後に次の試行を行うため。
      await getLiveState(
        c.env,
        NOTIFICATION_PERSIST_RPC_RETRY,
      ).setLiveNotificationMessageId(userId, broadcastId, messageId);
      return true;
    } catch (error: unknown) {
      const willRetry =
        attempt < NOTIFICATION_PERSIST_MAX_ATTEMPTS &&
        isTransientLiveStateError(error);
      logWarn(c.env, "live_notification.persist_failed", {
        ...createErrorLogFields(error),
        attempt,
        messageId,
        sessionId,
        userId,
        willRetry,
      });
      if (!willRetry) {
        return false;
      }
    }

    // oxlint-disable-next-line no-await-in-loop -- 失敗の原因が解消するのを待ってから次の試行を行うため。
    await wait(NOTIFICATION_PERSIST_RETRY_DELAY_MS);
  }
}

// インジェスト応答の返却後に waitUntil 内で実行されるため、失敗はすべて
// スローせずここでログ出力する。
async function sendLiveStartNotification(
  c: Context<AppEnv>,
  userId: string,
  broadcastId: string,
  sessionId: string,
  siteUrl: string,
): Promise<void> {
  let messageId: bigint;
  try {
    ({ messageId } = await sendLiveStartedNotification(c.env, userId, siteUrl));
  } catch (error: unknown) {
    logWarn(c.env, "live_notification.send_failed", {
      ...createErrorLogFields(error),
      sessionId,
      userId,
    });
    return;
  }

  // 通知は OBS の再接続をまたいで維持される配信本体に紐づいている。
  if (
    await persistLiveStartNotification(
      c,
      userId,
      broadcastId,
      sessionId,
      messageId.toString(),
    )
  ) {
    return;
  }

  // メッセージ ID が保存されたかどうか不明なため、後から自動で削除されない可能性がある。
  // ここで即座に削除しておく（保存済み ID に対する後続の削除はすでに存在しないことを検知して完了する）。
  try {
    await deleteLiveStartedNotification(c.env, messageId);
  } catch (error: unknown) {
    logWarn(c.env, "live_notification.orphan_delete_failed", {
      ...createErrorLogFields(error),
      messageId: messageId.toString(),
      sessionId,
      userId,
    });
  }
}

function wasSessionSeenActiveRecently(live: LiveRecord, now: number): boolean {
  return (
    live.sessionSeenActiveAt !== null &&
    now - live.sessionSeenActiveAt <= LIVE_SESSION_RECENTLY_ACTIVE_MS
  );
}

// ベストエフォート処理: この記録がない場合、後から DELETE なしでセッションを失うと
// OBS の再開を待たずに即座に配信が終了する。
function recordLiveSessionSeenActive(
  c: Context<AppEnv>,
  live: LiveRecord,
  now: number,
): void {
  // 健全な配信に参加する視聴者のほとんどは新鮮な記録を見つける。ここで書き込みだけでなく
  // 呼び出し自体をスキップすることで、視聴者が LiveState を起こさないようにする。
  if (
    live.sessionSeenActiveAt !== null &&
    now - live.sessionSeenActiveAt < LIVE_SESSION_SEEN_ACTIVE_WRITE_INTERVAL_MS
  ) {
    return;
  }

  c.executionCtx.waitUntil(
    getLiveState(c.env)
      .markLiveSessionSeenActive(
        live.userId,
        live.sessionId,
        LIVE_SESSION_SEEN_ACTIVE_WRITE_INTERVAL_MS,
      )
      .catch((error: unknown) => {
        logWarn(c.env, "live.session_activity_record_failed", {
          ...createErrorLogFields(error),
          sessionId: live.sessionId,
          userId: live.userId,
        });
      }),
  );
}

// リクエストが生存を確認した直後に Calls がインジェストセッションをガベージコレクション
// したため、OBS は DELETE を送らずにたった今セッションを失ったとみなせる。遅延した DELETE と
// 同様に扱い、再接続した OBS が再通知なしで再開できるよう配信と開始通知を短い猶予期間だけ保持する。
async function startLostSessionGrace(
  c: Context<AppEnv>,
  live: LiveRecord,
): Promise<void> {
  // その間に行が更新されていた場合（OBS が DELETE を送信または再開済み）、
  // 新しい状態に従ってすでに次の挙動が決まっている。
  const graceExpiresAt = await getLiveState(c.env).startLiveReconnectGrace(
    live.userId,
    live.sessionId,
    LIVE_LOST_SESSION_GRACE_MS,
  );
  if (graceExpiresAt === null) {
    return;
  }

  logInfo(c.env, "live.session_lost", {
    graceExpiresAt,
    sessionId: live.sessionId,
    userId: live.userId,
  });
}

function respondLiveReconnecting(c: Context<AppEnv>): Response {
  // 503 は視聴者にリトライ継続を指示し、404 は終了した配信に対してのみ返す。
  return c.text("Live stream is waiting for the publisher to reconnect", 503, {
    "Retry-After": String(LIVE_RECONNECTING_RETRY_AFTER_SECONDS),
  });
}

function isSdpContentType(contentType: string | undefined): boolean {
  if (!contentType) {
    return false;
  }

  return contentType.split(";")[0]?.trim().toLowerCase() === "application/sdp";
}

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

// OBS インジェストの認証には視聴者用 JWT ではなく、ユーザーごとの配信トークンを使用する。
app.use(
  "/ingest/:userId",
  hashedBearerAuth<AppEnv, "/ingest/:userId">({
    pepper: (c) => c.env.LIVE_TOKEN_PEPPER,
    token: (c) => {
      const { userId } = c.req.param();
      return getLiveState(c.env).getLiveTokenHash(userId);
    },
  }),
);
app.use(
  "/ingest/:userId/:sessionId",
  hashedBearerAuth<AppEnv, "/ingest/:userId/:sessionId">({
    pepper: (c) => c.env.LIVE_TOKEN_PEPPER,
    token: (c) => {
      const { userId } = c.req.param();
      return getLiveState(c.env).getLiveTokenHash(userId);
    },
  }),
);
app.use("/ingest/:userId", async (c, next) => {
  const { userId } = c.req.param();
  logInfo(c.env, "ingest.request", { userId });
  await next();
});
app.use("/ingest/:userId/:sessionId", async (c, next) => {
  const { sessionId, userId } = c.req.param();
  logInfo(c.env, "ingest.request", { sessionId, userId });
  await next();
});

app.get("/ingest/:userId", async (c) => {
  return c.body(null, 204);
});

// WHIP インジェストの開始。新しいインジェストは OBS の再接続待ち中の既存配信を
// 再開するか、開始通知を伴って新しい配信を開始する。
app.post("/ingest/:userId", async (c) => {
  const { userId } = c.req.param();
  if (!isSdpContentType(c.req.header("content-type"))) {
    return c.text("Content-Type must be application/sdp", 415);
  }

  const sdpOffer = await c.req.text();
  if (!sdpOffer || sdpOffer.trim().length === 0) {
    return c.text("SDP offer is required", 400);
  }

  const liveState = getLiveState(c.env);
  let resumableLive: LiveRecord | null = null;
  const now = Date.now();
  // 猶予期間が過ぎた配信は LiveState によってすでに終了されているため、
  // 猶予期限が保存されている場合は OBS がまだ再開できる状態にあることを必ず意味する。
  const existingLive = await liveState.getLive(userId);
  if (existingLive && existingLive.graceExpiresAt !== null) {
    resumableLive = existingLive;
  } else if (existingLive) {
    // Worker 内で SFU 全体の走査は行わない。今回のインジェスト試行をブロックしている
    // 1 行だけを確認する（OBS がクラッシュやネットワーク切断で DELETE せずに終了し、
    // Calls が元のセッションをガベージコレクションした後に重要となる）。
    let isActive: boolean;
    try {
      isActive = await isSessionActive(c.env, existingLive.sessionId);
    } catch (error: unknown) {
      if (!(error instanceof SfuApiError)) {
        throw error;
      }
      logError(c.env, "ingest.session_activity_check_failed", {
        ...createErrorLogFields(error),
        sessionId: existingLive.sessionId,
        userId,
      });
      return c.text("Failed to verify ingest session status", 502);
    }

    if (isActive) {
      // DELETE なしでセッションを失った直後に OBS が再試行している可能性がある。
      // Calls 上でセッションがまだ生存していたことを記録しておき、Calls による
      // ガベージコレクション後の再試行時に配信を再開できるようにする。
      recordLiveSessionSeenActive(c, existingLive, now);
      return c.text("A live stream is already active for this user", 400);
    }

    if (wasSessionSeenActiveRecently(existingLive, now)) {
      // セッションはたった今失われたばかりなので、これは OBS の再接続とみなす。
      resumableLive = existingLive;
    } else {
      // セッションは、たとえば新しい配信として開始された今回のインジェストより
      // 何日も前に失われていた可能性もあるため、新規配信として開始して通知する。
      // その間に行が更新されていた場合は、後続の挿入処理でこのインジェストを拒否する。
      await liveState.endLive(userId, existingLive.sessionId);
    }
  }

  let result: IngestSession;
  try {
    result = await startIngest(c.env, userId, sdpOffer);
  } catch (error: unknown) {
    if (!(error instanceof SfuApiError)) {
      throw error;
    }
    const negotiationError = error.toNegotiationClientError(
      "Failed to negotiate ingest session",
    );
    if (negotiationError) {
      return c.text(negotiationError.text, negotiationError.status);
    }

    logError(c.env, "ingest.negotiation_failed", {
      ...createErrorLogFields(error),
      userId,
    });
    return c.text("Internal Server Error", 500);
  }

  const respondWithAnswer = () =>
    c.body(result.sdpAnswer, 201, {
      "content-type": "application/sdp",
      etag: `"${result.sessionId}"`,
      location: `/ingest/${userId}/${result.sessionId}`,
    });

  // live 行はこの特定の Calls セッションとトラックセットを指している。OBS の再接続時は
  // 新しい SDP・セッション・mid が作られるため、再開時は配信本体と開始通知を維持したまま
  // それらを置き換える。
  if (
    resumableLive &&
    (await liveState.resumeLive(
      userId,
      resumableLive.sessionId,
      result.sessionId,
      result.tracks,
    ))
  ) {
    logInfo(c.env, "ingest.resumed", {
      previousSessionId: resumableLive.sessionId,
      reason:
        resumableLive.graceExpiresAt === null
          ? "session_lost"
          : "reconnect_grace",
      sessionId: result.sessionId,
      userId,
    });
    return respondWithAnswer();
  }

  // 再開対象がそもそも存在しなかったか、セッションのネゴシエーション中に配信が
  // 終了したため、新しい配信を開始する。
  const broadcastId = await liveState.insertLive(
    userId,
    result.sessionId,
    result.tracks,
  );
  if (broadcastId === null) {
    // 上で行を読み取った後で同じ配信者の競合する別インジェストが行を作成または
    // 再開したため、配信と通知の所有権はそちらにある。このインジェストの Calls セッションには
    // 誰も接続しないため、Calls 側で自動的にクリーンアップされる。
    logWarn(c.env, "ingest.concurrent_ingest_rejected", {
      sessionId: result.sessionId,
      userId,
    });
    return c.text("A live stream is already active for this user", 400);
  }

  const notifyParam = c.req.query("notify");
  if (notifyParam !== "false" && notifyParam !== "0") {
    c.executionCtx.waitUntil(
      sendLiveStartNotification(
        c,
        userId,
        broadcastId,
        result.sessionId,
        createSiteRootLocation(c.req.url),
      ),
    );
  }

  return respondWithAnswer();
});

// WHIP インジェストの終了。現在保存されているセッションのみがそのインジェストを終了できる。
app.get("/ingest/:userId/:sessionId", async () => {
  return new Response(null, { status: 204 });
});

app.delete("/ingest/:userId/:sessionId", async (c) => {
  const { userId, sessionId } = c.req.param();

  const liveState = getLiveState(c.env);
  const existingLive = await liveState.getLive(userId);
  if (!existingLive) {
    return c.text("No live stream found for this user", 400);
  }

  if (existingLive.sessionId !== sessionId) {
    return c.text("Session ID does not match the active live stream", 400);
  }

  if (existingLive.graceExpiresAt !== null) {
    // すでに終了済みのインジェストに対する重複 DELETE。
    return c.text("OK", 200);
  }

  if (
    existingLive.tracks.length === 0 ||
    existingLive.tracks.some((track) => track.mid.length === 0)
  ) {
    return c.text("Stored live track data is invalid", 500);
  }

  // OBS は再接続の直前にも DELETE を送信するため、配信停止と区別できない。
  // 配信本体と開始通知を猶予期間だけ維持し、新しいインジェストが再開しなければ
  // LiveState が配信を終了させる。
  const graceExpiresAt = await liveState.startLiveReconnectGrace(
    userId,
    sessionId,
    LIVE_RECONNECT_GRACE_MS,
  );
  if (graceExpiresAt === null) {
    return c.text("Failed to delete the requested live stream", 400);
  }

  // このインジェストセッションが終了したため、保存済みトラックロケーターは無効になる。
  scheduleTrackClose(
    c,
    sessionId,
    existingLive.tracks,
    `Failed to close live tracks for user ${userId}:`,
    `SFU reported track close errors for user ${userId}:`,
  );

  return c.text("OK", 200);
});

app.get("/login", (c) => {
  return startDiscordLogin(c);
});

app.get("/login/callback", async (c) => {
  return completeDiscordLogin(c);
});

app.post("/logout", csrf(), async (c) => {
  clearAuthCookie(c);
  return c.redirect("/");
});

// 視聴は認証済みアプリユーザーのみに制限する。
app.use("/play/*", csrf());
app.use("/play/*", async (c, next) => {
  const middleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  });
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Hono の jwt ミドルウェアが具象的なアプリコンテキスト型を消去するため。
  return middleware(c, next);
});
app.use("/play/*", async (c, next) => {
  const jwtPayload = c.get("jwtPayload");
  logInfo(c.env, "play.request", { userId: jwtPayload.userId });
  await next();
});

// WHEP 再生の開始。公開された汎用 WHEP エンドポイントではなく、意図的にアプリ固有かつ
// Cookie 保護されたエンドポイントとしている。
app.get("/play/:userId", async (c) => {
  return c.body(null, 204);
});

app.post("/play/:userId", async (c) => {
  const { userId } = c.req.param();

  const jwtPayload = c.get("jwtPayload");

  const now = Date.now();
  const liveState = getLiveState(c.env);
  const liveTrackRecord = await liveState.getLive(userId);
  const tracks = liveTrackRecord?.tracks ?? [];
  if (liveTrackRecord && liveTrackRecord.graceExpiresAt !== null) {
    // OBS が DELETE を送信した時点で保存済みトラックは閉じられている。OBS が配信を
    // 再開するか猶予期間経過で配信が終了する（その後 LiveState は行を返さなくなる）まで、
    // 視聴者はリトライし続ける。
    return respondLiveReconnecting(c);
  }
  if (liveTrackRecord) {
    // 再生リクエストは 1 人の配信者を特定するため、すべての配信行を走査せずに
    // 古いライブ状態と Calls の整合をとれる最も低コストかつ安全なポイントとなっている。
    let isActive: boolean;
    try {
      isActive = await isSessionActive(c.env, liveTrackRecord.sessionId);
    } catch (error: unknown) {
      if (!(error instanceof SfuApiError)) {
        throw error;
      }
      logError(c.env, "play.session_activity_check_failed", {
        ...createErrorLogFields(error),
        sessionId: liveTrackRecord.sessionId,
        userId,
      });
      return c.text("Failed to verify live stream status", 502);
    }
    if (!isActive) {
      if (wasSessionSeenActiveRecently(liveTrackRecord, now)) {
        await startLostSessionGrace(c, liveTrackRecord);
        return respondLiveReconnecting(c);
      }
      // その間に行が更新されていた場合（OBS が DELETE を送信または再開済み）、
      // 終了を報告するのではなく新しい状態に対して視聴者にリトライさせる。
      return (await liveState.endLive(userId, liveTrackRecord.sessionId))
        ? c.text(`Live stream not found: ${userId}`, 404)
        : respondLiveReconnecting(c);
    }
    // 配信者のセッションが失われた後もガベージコレクション待ちの間は視聴者が
    // 再生リクエストを送り続けるため、視聴者側でもセッション喪失を検知できる。
    recordLiveSessionSeenActive(c, liveTrackRecord, now);
  }

  if (!isSdpContentType(c.req.header("content-type"))) {
    return c.text("Content-Type must be application/sdp", 415);
  }

  const sdpOffer = await c.req.text();
  if (!sdpOffer || sdpOffer.trim().length === 0) {
    return c.text("SDP offer is required", 400);
  }

  let result: PlaybackSession;
  try {
    result = await startPlay(c.env, userId, tracks, sdpOffer);
  } catch (error: unknown) {
    if (error instanceof LiveNotFoundError) {
      return c.text(`Live stream not found: ${userId}`, 404);
    }
    if (!(error instanceof SfuApiError)) {
      throw error;
    }
    if (error.isSessionNotFound()) {
      if (liveTrackRecord) {
        // 上で確認した時点ではインジェストセッションは生存していたため、
        // Calls がたった今ガベージコレクションしたとみなせる。
        await startLostSessionGrace(c, liveTrackRecord);
        return respondLiveReconnecting(c);
      }
      return c.text(`Live stream not found: ${userId}`, 404);
    }
    logError(c.env, "play.negotiation_failed", {
      ...createErrorLogFields(error),
      userId,
      viewerUserId: jwtPayload.userId,
    });
    const negotiationError = error.toNegotiationClientError(
      "Failed to negotiate playback session",
    );
    if (negotiationError) {
      return c.text(negotiationError.text, negotiationError.status);
    }

    return c.text("Failed to negotiate playback session", 502);
  }

  const status = result.sdpType === "offer" ? 406 : 201;
  // ネゴシエートされた再生トラック数ではなく、保存されているライブ配信のトラック数を
  // 使用する。再生がトラックの一部しかネゴシエートできなかった場合、劣化したセッションを
  // 正常として受け入れるのではなく不完全とみなしてクライアントに再接続させる。
  const expectedTrackCount = tracks.length;

  return c.body(result.sdpAnswer, status, {
    "content-type": "application/sdp",
    "Wish-Live-Track-Count": String(expectedTrackCount),
    etag: `"${result.sessionId}"`,
    location: createPlaySessionLocation(
      c.req.url,
      userId,
      result.sessionId,
      result.tracks,
    ),
  });
});

// WHEP 再生セッションのクリーンアップおよびカウンターオファーへのアンサー送信。
app.get("/play/:userId/:sessionId", async () => {
  return new Response(null, { status: 204 });
});

app
  .delete("/play/:userId/:sessionId", async (c) => {
    const { sessionId } = c.req.param();
    if (!isCallsSessionId(sessionId)) {
      return c.text("Invalid WHEP session ID", 400);
    }
    const mids = getRequestedTrackMids(c.req.url);
    if (mids.length === 0) {
      return c.text("WHEP session track mids are required", 400);
    }

    scheduleTrackClose(
      c,
      sessionId,
      createWhepCloseTracks(sessionId, mids),
      `Failed to close WHEP session ${sessionId}:`,
      `SFU reported WHEP session close errors for session ${sessionId}:`,
    );

    return c.body(null, 200);
  }) // この PATCH はトリクル ICE ではなく、406 カウンターオファーへのアンサーを送信する。
  .patch(async (c) => {
    const { sessionId } = c.req.param();
    if (!isCallsSessionId(sessionId)) {
      return c.text("Invalid WHEP session ID", 400);
    }

    if (!isSdpContentType(c.req.header("content-type"))) {
      return c.text("Content-Type must be application/sdp", 415);
    }

    const sdpAnswer = await c.req.text();
    if (!sdpAnswer || sdpAnswer.trim().length === 0) {
      return c.text("SDP answer is required", 400);
    }

    try {
      await renegotiateSession(c.env, sessionId, sdpAnswer);
    } catch (error: unknown) {
      if (!(error instanceof SfuApiError)) {
        throw error;
      }
      const negotiationError = error.toNegotiationClientError(
        "Failed to submit WHEP answer",
      );
      if (negotiationError) {
        return c.text(negotiationError.text, negotiationError.status);
      }

      logError(c.env, "play.answer_submission_failed", {
        ...createErrorLogFields(error),
        sessionId,
      });
      return c.text("Failed to submit WHEP answer", 502);
    }

    return c.body(null, 204);
  });

// すべての /api ルートはアプリの JWT Cookie を必要とするブラウザ向け API である。
app.use("/api/*", csrf());
app.use("/api/*", async (c, next) => {
  const middleware = jwt({
    secret: c.env.JWT_SECRET,
    cookie: "authtoken",
    alg: "HS256",
  });
  // oxlint-disable-next-line typescript/no-unsafe-argument -- Hono の jwt ミドルウェアが具象的なアプリコンテキスト型を消去するため。
  return middleware(c, next);
});
app.use("/api/*", async (c, next) => {
  const jwtPayload = c.get("jwtPayload");
  logInfo(c.env, "api.request", { userId: jwtPayload.userId });
  await next();
});

app.get("/api/me", async (c) => {
  const jwtPayload = c.get("jwtPayload");

  return c.json({
    userId: jwtPayload.userId,
    displayName: jwtPayload.displayName,
  });
});

app.get("/api/turn-credentials", async (c) => {
  const jwtPayload = c.get("jwtPayload");
  // TURN クレデンシャルは認証済み Worker API の背後に保持する。ブラウザ
  // クライアントは非認証の汎用 WHEP エンドポイントクライアントとしては設計していない。
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
app.post("/api/me/livetoken", async (c) => {
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
  });
});

// 副作用のないトークン状態確認。既存のトークン値は決して返さない。
app.get("/api/me/livetoken", async (c) => {
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

  return c.json({ hasToken });
});

app.get("/api/lives", async (c) => {
  // 一覧取得を軽量に保つため、ここではすべての配信行に対して Calls をポーリングしない。
  // 古い行は、ユーザーが特定のストリームに対してインジェストまたは再生を試みたときに整合をとる。
  const lives = await getLiveState(c.env).getAllLives();
  return c.json(lives);
});

export default app;
