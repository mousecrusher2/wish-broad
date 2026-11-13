import { describe, expect, it } from "vitest";
import { WHEPSessionError } from "./WHEPClient";
import {
  resolveReconnectDisposition,
  shouldReconnectForPlaybackStall,
  shouldReconnectForTrackDiscoveryTimeout,
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
        new WHEPSessionError("waiting for the publisher", {
          kind: "resource_unavailable",
          responseText: undefined,
          stage: "post",
        }),
      ),
    ).toBe("retry");
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
    expect(
      resolveReconnectDisposition(
        new WHEPSessionError("temporary response issue", {
          kind: "unexpected_response",
          responseText: undefined,
          stage: "post",
        }),
      ),
    ).toBe("retry");
    expect(resolveReconnectDisposition(new Error("network"))).toBe("retry");
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

  it("reconnects after three seconds without inbound bytesReceived progress", () => {
    expect(shouldReconnectForPlaybackStall(0)).toBe(false);
    expect(shouldReconnectForPlaybackStall(999)).toBe(false);
    expect(shouldReconnectForPlaybackStall(1_000)).toBe(false);
    expect(shouldReconnectForPlaybackStall(2_999)).toBe(false);
    expect(shouldReconnectForPlaybackStall(3_000)).toBe(true);
  });

  it("waits for all expected inbound RTP receivers before reconnecting", () => {
    expect(shouldReconnectForTrackDiscoveryTimeout(14_999)).toBe(false);
    expect(shouldReconnectForTrackDiscoveryTimeout(15_000)).toBe(true);
  });
});
