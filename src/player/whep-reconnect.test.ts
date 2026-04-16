import { describe, expect, it } from "vitest";
import { WHEPSessionError } from "./WHEPClient";
import {
  WHEP_RECONNECT_WINDOW_MS,
  getReconnectDelayMs,
  resolveReconnectDisposition,
  shouldReconnectForPlaybackStall,
  shouldRecoverEstablishedSession,
} from "./whep-reconnect";

describe("whep-reconnect", () => {
  it("classifies reconnect outcomes", () => {
    expect(
      resolveReconnectDisposition(
        new WHEPSessionError("missing live", {
          kind: "resource_not_found",
          responseText: undefined,
          stage: "post",
        }),
      ),
    ).toBe("ended");
    expect(
      resolveReconnectDisposition(
        new WHEPSessionError("unauthorized", {
          kind: "client_request_error",
          responseText: undefined,
          stage: "post",
        }),
      ),
    ).toBe("error");
    expect(
      resolveReconnectDisposition(
        new WHEPSessionError("malformed response", {
          kind: "unexpected_response",
          responseText: undefined,
          retryable: false,
          stage: "post",
        }),
      ),
    ).toBe("error");
    expect(resolveReconnectDisposition(new Error("network"))).toBe("retry");
  });

  it("uses exponential backoff capped by the remaining reconnect window", () => {
    expect(getReconnectDelayMs(0, 10_000)).toBe(500);
    expect(getReconnectDelayMs(1, 10_000)).toBe(1_000);
    expect(getReconnectDelayMs(2, 10_000)).toBe(2_000);
    expect(getReconnectDelayMs(4, 10_000)).toBe(2_000);
    expect(getReconnectDelayMs(4, 1_500)).toBe(1_500);
  });

  it("detects established sessions that should be recovered", () => {
    expect(
      shouldRecoverEstablishedSession({
        connectionState: "connected",
        expectedRemoteTrackCount: 2,
        hasStream: true,
        iceConnectionState: "connected",
        liveTrackCount: 2,
        mutedTrackCount: 0,
        remoteTrackCount: 2,
        signalingState: "stable",
        status: "connected",
      }),
    ).toBe(false);
    expect(
      shouldRecoverEstablishedSession({
        connectionState: "connecting",
        expectedRemoteTrackCount: 1,
        hasStream: false,
        iceConnectionState: "checking",
        liveTrackCount: 0,
        mutedTrackCount: 0,
        remoteTrackCount: 1,
        signalingState: "stable",
        status: "connecting",
      }),
    ).toBe(false);
    expect(
      shouldRecoverEstablishedSession({
        connectionState: "disconnected",
        expectedRemoteTrackCount: 1,
        hasStream: false,
        iceConnectionState: "disconnected",
        liveTrackCount: 0,
        mutedTrackCount: 0,
        remoteTrackCount: 1,
        signalingState: "stable",
        status: "disconnected",
      }),
    ).toBe(true);
    expect(
      shouldRecoverEstablishedSession({
        connectionState: "failed",
        expectedRemoteTrackCount: 1,
        hasStream: false,
        iceConnectionState: "failed",
        liveTrackCount: 0,
        mutedTrackCount: 0,
        remoteTrackCount: 1,
        signalingState: "stable",
        status: "failed",
      }),
    ).toBe(true);
  });

  it("reconnects only for real playback stalls", () => {
    expect(shouldReconnectForPlaybackStall("initial", false, 10_000)).toBe(
      false,
    );
    expect(shouldReconnectForPlaybackStall("retry", false, 4_000)).toBe(false);
    expect(shouldReconnectForPlaybackStall("retry", false, 5_000)).toBe(true);
    expect(shouldReconnectForPlaybackStall("initial", true, 4_000)).toBe(true);
    expect(shouldReconnectForPlaybackStall("retry", true, 4_000)).toBe(true);
  });

  it("keeps the reconnect window at thirty seconds", () => {
    expect(WHEP_RECONNECT_WINDOW_MS).toBe(30_000);
  });
});
