import {
  reset,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { env, exports } from "cloudflare:workers";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import { LIVE_RECONNECT_GRACE_MS } from "../../shared/protocol";
import { getLiveState } from "../state/live-state";

/** 実際のアラームが自動発火しないよう、テストの時計は遠い未来に置く。 */
const NOW = Date.UTC(2100, 0, 1);

const WEBHOOK_URL = env.NOTIFICATIONS_DISCORD_WEBHOOK_URL;

describe("live effects", () => {
  let fetchSpy: MockInstance<typeof fetch>;

  beforeEach(() => {
    vi.setSystemTime(NOW);
    // Discord Webhook の DELETE に成功を返す。
    fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(null, { status: 204 }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await reset();
  });

  it("returns to the live state before Discord answers", async () => {
    let respond!: (response: Response) => void;
    fetchSpy.mockReturnValue(
      new Promise<Response>((resolve) => {
        respond = resolve;
      }),
    );

    await exports.LiveEffects.deleteStartNotifications([
      { messageId: "9", userId: "user-1" },
    ]);

    // オブジェクトは Discord の応答を待たずに次の処理へ進める。
    await vi.waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledOnce();
    });
    respond(new Response(null, { status: 204 }));
  });

  it("deletes an ended broadcast's notification once the alarm ends it", async () => {
    const liveState = getLiveState(env);
    const broadcastId = await liveState.insertLive("user-1", "session-1", []);
    assert.isNotNull(broadcastId, "Expected a new broadcast");
    await liveState.setLiveNotificationMessageId("user-1", broadcastId, "9");
    await liveState.startLiveReconnectGrace(
      "user-1",
      "session-1",
      LIVE_RECONNECT_GRACE_MS,
    );

    vi.setSystemTime(NOW + LIVE_RECONNECT_GRACE_MS);
    await expect(runDurableObjectAlarm(liveState)).resolves.toBe(true);

    await vi.waitFor(() => {
      expect(
        fetchSpy.mock.calls.map(([input, init]) => {
          expect(init?.method).toBe("DELETE");
          return input instanceof Request ? input.url : input.toString();
        }),
      ).toEqual([`${WEBHOOK_URL}/messages/9`]);
    });
    await expect(liveState.getLive("user-1")).resolves.toBeNull();
    await expect(
      runInDurableObject(liveState, async (_instance, state) =>
        state.storage.getAlarm(),
      ),
    ).resolves.toBeNull();
  });
});
