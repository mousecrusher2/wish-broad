import { describe, expect, it } from "vitest";
import { WHEPSessionError } from "./WHEPClient";
import {
  WHEP_CONNECTING_RESUME_GRACE_MS,
  createRetryResolutionState,
  classifyRetryFailure,
  createReconnectDeadline,
  getReconnectDelayMs,
  isInitialPlaybackClientError,
  resolveRetryResolution,
  shouldReconnectOnResume,
  updateRetryResolutionState,
  WHEP_RECONNECT_WINDOW_MS,
} from "./whep-reconnect";

describe("whep-reconnect", () => {
  it("retries initial playback failures unless the server returned a 4xx", () => {
    expect(
      isInitialPlaybackClientError(
        new WHEPSessionError("not found", {
          responseText: undefined,
          stage: "post",
          statusCode: 404,
        }),
      ),
    ).toBe(true);
    expect(
      isInitialPlaybackClientError(
        new WHEPSessionError("invalid sdp", {
          responseText: undefined,
          stage: "post",
          statusCode: 422,
        }),
      ),
    ).toBe(true);
    expect(
      isInitialPlaybackClientError(
        new WHEPSessionError("missing location", {
          responseText: undefined,
          retryable: false,
          stage: "post",
          statusCode: 201,
        }),
      ),
    ).toBe(true);
    expect(
      isInitialPlaybackClientError(
        new WHEPSessionError("server error", {
          responseText: undefined,
          stage: "post",
          statusCode: 503,
        }),
      ),
    ).toBe(false);
    expect(isInitialPlaybackClientError(new Error("network"))).toBe(false);
  });

  it("classifies 404 playback failures as not found", () => {
    expect(
      classifyRetryFailure(
        new WHEPSessionError("missing live", {
          responseText: undefined,
          stage: "post",
          statusCode: 404,
        }),
      ),
    ).toBe("notFound");
    expect(
      classifyRetryFailure(
        new WHEPSessionError("unauthorized", {
          responseText: undefined,
          stage: "post",
          statusCode: 401,
        }),
      ),
    ).toBe("fatal");
    expect(
      classifyRetryFailure(
        new WHEPSessionError("malformed response", {
          responseText: undefined,
          retryable: false,
          stage: "post",
          statusCode: 201,
        }),
      ),
    ).toBe("fatal");
    expect(
      classifyRetryFailure(
        new WHEPSessionError("upstream error", {
          responseText: undefined,
          stage: "post",
          statusCode: 502,
        }),
      ),
    ).toBe("error");
    expect(classifyRetryFailure(new Error("network"))).toBe("error");
  });

  it("uses exponential backoff capped by the remaining retry window", () => {
    expect(getReconnectDelayMs(0, 10_000)).toBe(500);
    expect(getReconnectDelayMs(1, 10_000)).toBe(1_000);
    expect(getReconnectDelayMs(2, 10_000)).toBe(2_000);
    expect(getReconnectDelayMs(3, 10_000)).toBe(4_000);
    expect(getReconnectDelayMs(4, 2_500)).toBe(2_500);
  });

  it("resolves the retry window as ended only when every failure was not found", () => {
    expect(
      resolveRetryResolution({
        sawError: false,
        sawNotFound: true,
      }),
    ).toBe("ended");
    expect(
      resolveRetryResolution({
        sawError: false,
        sawNotFound: false,
      }),
    ).toBe("error");
  });

  it("treats transient reconnect failures as unresolved until the server answers", () => {
    const transientOnly = updateRetryResolutionState(null, "transient");
    expect(resolveRetryResolution(transientOnly)).toBe("error");
    expect(transientOnly).toEqual(createRetryResolutionState());

    const transientThenNotFound = updateRetryResolutionState(
      transientOnly,
      "notFound",
    );
    expect(resolveRetryResolution(transientThenNotFound)).toBe("ended");

    const transientThenError = updateRetryResolutionState(
      transientThenNotFound,
      "error",
    );
    expect(resolveRetryResolution(transientThenError)).toBe("error");
  });

  it("reconnects on resume when the session is connected but tracks are gone", () => {
    expect(
      shouldReconnectOnResume({
        connectionState: "connecting",
        expectedRemoteTrackCount: 0,
        hasStream: false,
        iceConnectionState: "checking",
        liveTrackCount: 0,
        mutedTrackCount: 0,
        remoteTrackCount: 0,
        signalingState: "have-local-offer",
        status: "connecting",
      }),
    ).toBe(false);
    expect(
      shouldReconnectOnResume(
        {
          connectionState: "connecting",
          expectedRemoteTrackCount: 0,
          hasStream: false,
          iceConnectionState: "checking",
          liveTrackCount: 0,
          mutedTrackCount: 0,
          remoteTrackCount: 0,
          signalingState: "have-local-offer",
          status: "connecting",
        },
        {
          connectingStartedAt: 1_000,
          now: 1_000 + WHEP_CONNECTING_RESUME_GRACE_MS - 1,
        },
      ),
    ).toBe(false);
    expect(
      shouldReconnectOnResume(
        {
          connectionState: "connecting",
          expectedRemoteTrackCount: 0,
          hasStream: false,
          iceConnectionState: "checking",
          liveTrackCount: 0,
          mutedTrackCount: 0,
          remoteTrackCount: 0,
          signalingState: "have-local-offer",
          status: "connecting",
        },
        {
          connectingStartedAt: 1_000,
          now: 1_000 + WHEP_CONNECTING_RESUME_GRACE_MS,
        },
      ),
    ).toBe(true);
    expect(
      shouldReconnectOnResume({
        connectionState: "connected",
        expectedRemoteTrackCount: 1,
        hasStream: false,
        iceConnectionState: "disconnected",
        liveTrackCount: 1,
        mutedTrackCount: 1,
        remoteTrackCount: 1,
        signalingState: "stable",
        status: "connecting",
      }),
    ).toBe(false);
    expect(
      shouldReconnectOnResume({
        connectionState: "connected",
        expectedRemoteTrackCount: 0,
        hasStream: false,
        iceConnectionState: "connected",
        liveTrackCount: 0,
        mutedTrackCount: 0,
        remoteTrackCount: 0,
        signalingState: "stable",
        status: "connected",
      }),
    ).toBe(false);
    expect(
      shouldReconnectOnResume({
        connectionState: "connected",
        expectedRemoteTrackCount: 2,
        hasStream: false,
        iceConnectionState: "connected",
        liveTrackCount: 2,
        mutedTrackCount: 2,
        remoteTrackCount: 2,
        signalingState: "stable",
        status: "connected",
      }),
    ).toBe(false);
    expect(
      shouldReconnectOnResume({
        connectionState: "connected",
        expectedRemoteTrackCount: 2,
        hasStream: false,
        iceConnectionState: "connected",
        liveTrackCount: 1,
        mutedTrackCount: 0,
        remoteTrackCount: 2,
        signalingState: "stable",
        status: "connected",
      }),
    ).toBe(true);
    expect(
      shouldReconnectOnResume({
        connectionState: "connected",
        expectedRemoteTrackCount: 1,
        hasStream: false,
        iceConnectionState: "connected",
        liveTrackCount: 1,
        mutedTrackCount: 1,
        remoteTrackCount: 1,
        signalingState: "stable",
        status: "connected",
      }),
    ).toBe(false);
  });

  it("creates a retry deadline ten seconds in the future", () => {
    expect(createReconnectDeadline(123)).toBe(123 + WHEP_RECONNECT_WINDOW_MS);
  });
});
