// レシーバーごとの bytesReceived の増加から、再生が止まったかを判定する。この監視が配信終了を
// 検知する主要な経路である理由は docs/architecture.md の「フロントエンドのリカバリー」を参照。
import type { WHEPInboundReceiverStat } from "./session";

export const WHEP_STALL_POLL_INTERVAL_MS = 1_000;

/** いずれかのレシーバーの bytesReceived がこの時間増えなければ、再生が止まったとみなす。 */
const WHEP_PLAYBACK_STALL_MS = 3_000;

type ReceiverProgress = { bytesReceived: number; stalledForMs: number };

/**
 * 停止判定の状態。`receivers` は期待される数のレシーバーが統計情報に揃うまで null で、
 * 揃った時点のレシーバーだけを以後監視する。
 */
export type StallMonitorState = {
  expectedTrackCount: number;
  receivers: ReadonlyMap<string, ReceiverProgress> | null;
};

export function createStallMonitorState(
  expectedTrackCount: number,
): StallMonitorState {
  return {
    expectedTrackCount: Math.max(1, expectedTrackCount),
    receivers: null,
  };
}

/**
 * `WHEP_STALL_POLL_INTERVAL_MS` ごとに読み取った統計情報を反映した次の状態を返す。`stalled` は
 * 監視中のレシーバーのいずれかが bytesReceived を `WHEP_PLAYBACK_STALL_MS` 以上増やさなかった場合に true。
 * `flowing` は監視中のすべてのレシーバーが前回の読み取りから bytesReceived を増やした場合に true で、
 * レシーバーが揃った最初の読み取りでは比較対象がないため false。
 */
export function observeReceiverStats(
  state: StallMonitorState,
  receiverStats: readonly WHEPInboundReceiverStat[],
): { flowing: boolean; stalled: boolean; state: StallMonitorState } {
  if (state.receivers === null) {
    if (receiverStats.length < state.expectedTrackCount) {
      return { flowing: false, stalled: false, state };
    }

    const receivers = new Map(
      receiverStats.map((stat) => [
        stat.id,
        { bytesReceived: stat.bytesReceived, stalledForMs: 0 },
      ]),
    );
    return { flowing: false, stalled: false, state: { ...state, receivers } };
  }

  const statsById = new Map(receiverStats.map((stat) => [stat.id, stat]));
  const receivers = new Map<string, ReceiverProgress>();
  let flowing = true;
  let stalled = false;
  for (const [id, previous] of state.receivers) {
    const stat = statsById.get(id);
    // 統計情報から消えたレシーバーも、メディアが届いていないものとして数える。
    const progressed =
      stat !== undefined && stat.bytesReceived > previous.bytesReceived;
    const stalledForMs = progressed
      ? 0
      : previous.stalledForMs + WHEP_STALL_POLL_INTERVAL_MS;
    receivers.set(id, {
      bytesReceived: stat?.bytesReceived ?? previous.bytesReceived,
      stalledForMs,
    });
    flowing &&= progressed;
    stalled ||= stalledForMs >= WHEP_PLAYBACK_STALL_MS;
  }

  return { flowing, stalled, state: { ...state, receivers } };
}
