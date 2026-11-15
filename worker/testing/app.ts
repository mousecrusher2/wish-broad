// ルートのテストが共有するヘルパー。外部 API のクライアントは各テストファイルが vi.mock で
// 差し替え、LiveState は実際の Durable Object をそのまま使う。
import {
  createExecutionContext,
  reset,
  runInDurableObject,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { sign } from "hono/jwt";
import { afterEach, assert, beforeEach, type MockInstance, vi } from "vitest";
import app from "../app";
import { LiveEffects } from "../live/effects";
import type { StoredTrack } from "../live/types";
import { getLiveState, LiveState } from "../state/live-state";
import type { Bindings } from "../types";

/** 実際のアラームが自動発火しないよう、テストの時計は遠い未来に置く。 */
export const NOW = Date.UTC(2100, 0, 1);

export function createTracks(sessionId: string): StoredTrack[] {
  return [
    {
      location: "remote",
      mid: "0",
      sessionId,
      trackName: "video",
    },
  ];
}

export type WorkerTestSpies = {
  consoleError: MockInstance<Console["error"]>;
  consoleInfo: MockInstance<Console["info"]>;
  consoleWarn: MockInstance<Console["warn"]>;
  /** LiveState が開始通知の削除を引き渡す先。削除そのものは ../live/notifications.test.ts で検証する。 */
  dispatch: MockInstance<LiveEffects["deleteStartNotifications"]>;
};

/**
 * 各テストの前に時計を `NOW` に固定して console と LiveEffects を差し替え、後で LiveState を
 * 初期化する。返すオブジェクトのスパイは各テストの開始時に差し替わる。
 */
export function setUpWorkerTest(): WorkerTestSpies {
  let current: WorkerTestSpies | null = null;
  const getCurrent = (): WorkerTestSpies => {
    assert.isNotNull(current, "Spies are only available inside a test");
    return current;
  };

  beforeEach(() => {
    vi.setSystemTime(NOW);
    vi.spyOn(console, "debug").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // テストランナーの console はアクセスのたびに別の関数を返すため、スパイは戻り値で参照する。
    current = {
      consoleError: vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined),
      consoleInfo: vi
        .spyOn(console, "info")
        .mockImplementation(() => undefined),
      consoleWarn: vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined),
      dispatch: vi
        .spyOn(LiveEffects.prototype, "deleteStartNotifications")
        .mockImplementation(() => undefined),
    };
  });

  afterEach(async () => {
    current = null;
    vi.useRealTimers();
    await reset();
  });

  return {
    get consoleError() {
      return getCurrent().consoleError;
    },
    get consoleInfo() {
      return getCurrent().consoleInfo;
    },
    get consoleWarn() {
      return getCurrent().consoleWarn;
    },
    get dispatch() {
      return getCurrent().dispatch;
    },
  };
}

export async function createAuthCookie(
  overrides?: Partial<{
    displayName: string;
    userId: string;
  }>,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    {
      displayName: overrides?.displayName ?? "Viewer",
      exp: now + 60 * 60,
      iat: now,
      userId: overrides?.userId ?? "viewer-1",
    },
    env.JWT_SECRET,
    "HS256",
  );

  return `authtoken=${token}`;
}

export async function fetchApp(
  request: Request,
  executionContext = createExecutionContext(),
  bindings: Bindings = env,
): Promise<Response> {
  return app.fetch(request, bindings, executionContext);
}

/**
 * 公開されている LiveState のメソッドだけを使って配信を開始した状態を作り、
 * その配信 ID を返す。各時刻はテストの現在時刻からの相対値で指定する。
 */
export async function seedLive({
  graceMs,
  notificationMessageId,
  sessionId = "session-1",
  sessionSeenActiveAt,
  tracks = createTracks(sessionId),
  userId = "user-1",
}: {
  graceMs?: number;
  notificationMessageId?: string;
  sessionId?: string;
  sessionSeenActiveAt?: number;
  tracks?: StoredTrack[];
  userId?: string;
} = {}): Promise<string> {
  const liveState = getLiveState(env);
  const broadcastId = await liveState.insertLive(userId, sessionId, tracks);
  assert.isNotNull(broadcastId, "Expected a new broadcast");
  if (notificationMessageId !== undefined) {
    await liveState.setLiveNotificationMessageId(
      userId,
      broadcastId,
      notificationMessageId,
    );
  }
  if (sessionSeenActiveAt !== undefined) {
    // LiveState は自身の時計で記録するため、記録時刻まで時計を戻してから記録させる。
    const now = Date.now();
    vi.setSystemTime(sessionSeenActiveAt);
    await liveState.markLiveSessionSeenActive(userId, sessionId, 0);
    vi.setSystemTime(now);
  }
  if (graceMs !== undefined) {
    await liveState.startLiveReconnectGrace(userId, sessionId, graceMs);
  }
  return broadcastId;
}

export async function getLive(userId = "user-1") {
  return getLiveState(env).getLive(userId);
}

/** 配信行に保存されている開始通知のメッセージ ID。 */
export async function getStoredNotificationMessageId(
  userId = "user-1",
): Promise<SqlStorageValue> {
  return runInDurableObject(
    getLiveState(env),
    (_instance, state) =>
      state.storage.sql
        .exec(
          "SELECT notification_message_id FROM lives WHERE user_id = ?",
          userId,
        )
        .toArray()[0]?.["notification_message_id"] ?? null,
  );
}

export async function getStoredUsers(): Promise<
  Record<string, SqlStorageValue>[]
> {
  return runInDurableObject(getLiveState(env), (_instance, state) =>
    state.storage.sql
      .exec("SELECT user_id, display_name FROM users ORDER BY user_id")
      .toArray(),
  );
}

export async function getLiveStateAlarm(): Promise<number | null> {
  return runInDurableObject(getLiveState(env), async (_instance, state) =>
    state.storage.getAlarm(),
  );
}

/**
 * ルートが LiveState から配信行を読んだ直後に別の処理を割り込ませ、Worker が行う
 * 2 つのオブジェクト呼び出しの間に競合するリクエストが状態を変えた（または時計が進んだ）
 * 状況を再現する。
 */
export function interleaveAfterNextGetLive(
  interleaved: (liveState: LiveState) => Promise<unknown> | undefined,
): void {
  // oxlint-disable-next-line typescript/unbound-method -- 元の実装をスパイの中から呼び出すため。
  const { getLive: readLive } = LiveState.prototype;
  vi.spyOn(LiveState.prototype, "getLive").mockImplementationOnce(
    async function (this: LiveState, userId: string) {
      const live = await readLive.call(this, userId);
      await interleaved(this);
      return live;
    },
  );
}
