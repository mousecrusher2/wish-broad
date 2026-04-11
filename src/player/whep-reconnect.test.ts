import { describe, expect, it } from "vitest";
import { WHEPSessionError } from "./WHEPClient";
import {
  WHEP_RECONNECT_WINDOW_MS,
  classifyReconnectFailure,
  createReconnectDeadline,
  getReconnectDelayMs,
  shouldRecoverEstablishedSession,
} from "./whep-reconnect";

describe("whep-reconnect", () => {
  it("classifies retryable and terminal reconnect failures", () => {
    expect(
      classifyReconnectFailure(
        new WHEPSessionError("missing live", {
          responseText: undefined,
          stage: "post",
          statusCode: 404,
        }),
      ),
    ).toBe("notFound");
    expect(
      classifyReconnectFailure(
        new WHEPSessionError("unauthorized", {
          responseText: undefined,
          stage: "post",
          statusCode: 401,
        }),
      ),
    ).toBe("fatal");
    expect(
      classifyReconnectFailure(
        new WHEPSessionError("malformed response", {
          responseText: undefined,
          retryable: false,
          stage: "post",
          statusCode: 201,
        }),
      ),
    ).toBe("fatal");
    expect(classifyReconnectFailure(new Error("network"))).toBe("error");
  });

  it("uses exponential backoff capped by the remaining reconnect window", () => {
    expect(getReconnectDelayMs(0, 10_000)).toBe(500);
    expect(getReconnectDelayMs(1, 10_000)).toBe(1_000);
    expect(getReconnectDelayMs(2, 10_000)).toBe(2_000);
    expect(getReconnectDelayMs(4, 2_500)).toBe(2_500);
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
        connectionState: "connected",
        expectedRemoteTrackCount: 2,
        hasStream: false,
        iceConnectionState: "connected",
        liveTrackCount: 1,
        mutedTrackCount: 1,
        remoteTrackCount: 2,
        signalingState: "stable",
        status: "connected",
      }),
    ).toBe(true);
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
  });

  it("creates a reconnect deadline thirty seconds in the future", () => {
    expect(createReconnectDeadline(123)).toBe(123 + WHEP_RECONNECT_WINDOW_MS);
  });
});
