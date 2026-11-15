import { describe, expect, it } from "vitest";
import type { WHEPInboundReceiverStat } from "./session";
import {
  createStallMonitorState,
  observeReceiverStats,
  type StallMonitorState,
} from "./stall-monitor";

function videoStat(bytesReceived: number, id = "0"): WHEPInboundReceiverStat {
  return { bytesReceived, id, kind: "video" };
}

function audioStat(bytesReceived: number, id = "1"): WHEPInboundReceiverStat {
  return { bytesReceived, id, kind: "audio" };
}

/** 統計情報を 1 秒ごとに順に反映し、各回の `stalled` を返す。 */
function observeSequence(
  initialState: StallMonitorState,
  statsPerTick: WHEPInboundReceiverStat[][],
): boolean[] {
  let state = initialState;
  return statsPerTick.map((receiverStats) => {
    const observation = observeReceiverStats(state, receiverStats);
    state = observation.state;
    return observation.stalled;
  });
}

describe("stall-monitor", () => {
  it("waits until the expected number of receivers appear in the stats", () => {
    const initial = createStallMonitorState(2);

    const partial = observeReceiverStats(initial, [videoStat(100)]);
    expect(partial).toEqual({ stalled: false, state: initial });

    const discovered = observeReceiverStats(partial.state, [
      videoStat(100),
      audioStat(50),
    ]);
    expect(discovered.stalled).toBe(false);
    expect([...(discovered.state.receivers?.keys() ?? [])]).toEqual(["0", "1"]);
  });

  it("expects at least one receiver even when the worker reports none", () => {
    expect(createStallMonitorState(0).expectedTrackCount).toBe(1);
    expect(observeReceiverStats(createStallMonitorState(0), [])).toMatchObject({
      state: { receivers: null },
    });
  });

  it("reports a stall after three seconds without bytesReceived progress", () => {
    expect(
      observeSequence(createStallMonitorState(1), [
        [videoStat(100)],
        [videoStat(100)],
        [videoStat(100)],
        [videoStat(100)],
      ]),
    ).toEqual([false, false, false, true]);
  });

  it("resets a receiver's stall time whenever its bytes grow", () => {
    expect(
      observeSequence(createStallMonitorState(1), [
        [videoStat(100)],
        [videoStat(100)],
        [videoStat(100)],
        [videoStat(200)],
        [videoStat(200)],
        [videoStat(200)],
      ]),
    ).toEqual([false, false, false, false, false, false]);
  });

  it("reports a stall when any one monitored receiver stops", () => {
    expect(
      observeSequence(createStallMonitorState(2), [
        [videoStat(100), audioStat(50)],
        [videoStat(200), audioStat(50)],
        [videoStat(300), audioStat(50)],
        [videoStat(400), audioStat(50)],
      ]),
    ).toEqual([false, false, false, true]);
  });

  it("counts a receiver missing from the stats as stalled", () => {
    expect(
      observeSequence(createStallMonitorState(1), [
        [videoStat(100)],
        [],
        [],
        [videoStat(100)],
      ]),
    ).toEqual([false, false, false, true]);
  });

  it("only monitors the receivers present when discovery finished", () => {
    expect(
      observeSequence(createStallMonitorState(1), [
        [videoStat(100)],
        [videoStat(200), audioStat(0)],
        [videoStat(300), audioStat(0)],
        [videoStat(400), audioStat(0)],
      ]),
    ).toEqual([false, false, false, false]);
  });
});
