import { describe, expect, it } from "vitest";
import { LIVE_RECONNECT_GRACE_MS } from "../../shared/protocol";
import { WHEPSessionError } from "./signaling";
import {
  resolveReconnectDisposition,
  shouldRecoverEstablishedSession,
  WHEP_RECONNECT_WINDOW_MS,
} from "./reconnect-policy";

describe("reconnect-policy", () => {
  it("keeps waiting longer than the publisher's reconnect grace period", () => {
    expect(WHEP_RECONNECT_WINDOW_MS).toBeGreaterThan(LIVE_RECONNECT_GRACE_MS);
  });

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
});
