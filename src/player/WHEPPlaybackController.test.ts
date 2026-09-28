// @vitest-environment jsdom
// oxlint-disable typescript/no-floating-promises -- Tests resolve mocked WHEP starts manually and await only the attempt being verified.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WHEPConnectionStatus,
  WHEPInboundReceiverStat,
  WHEPSessionSnapshot,
} from "./WHEPClient";
import {
  WHEP_RECONNECT_WINDOW_MS,
  WHEP_TRACK_DISCOVERY_GRACE_MS,
} from "./whep-reconnect";

type MockSessionErrorOptions = {
  kind?:
    | "resource_not_found"
    | "client_request_error"
    | "server_request_error"
    | "unexpected_response";
  retryable?: boolean;
};
type MockStartResult = { error?: Error; isErr: () => boolean };
type MockCallbacks = {
  onStatusChange?: (status: WHEPConnectionStatus) => void;
  onStreamChange?: (hasStream: boolean) => void;
};
type MockSessionRecord = {
  callbacks: MockCallbacks;
  disposeCount: number;
  disposeOptions: Array<{ notifyServer?: boolean }>;
  emitStatus: (status: WHEPConnectionStatus) => void;
  emitStream: (hasStream: boolean) => void;
  getSnapshot: () => WHEPSessionSnapshot;
  getStatsCallCount: () => number;
  receiverStats: WHEPInboundReceiverStat[];
  statsCallCount: number;
  statsPromise: Promise<WHEPInboundReceiverStat[]> | null;
  rejectStart: (error: Error) => void;
  resolveStart: (result?: MockStartResult) => void;
  startSignal: AbortSignal | null;
  snapshot: WHEPSessionSnapshot;
};

const mockSessions = vi.hoisted<Array<MockSessionRecord>>(() => []);

vi.mock("./WHEPClient", () => {
  class MockWHEPSessionError extends Error {
    readonly retryable: boolean;
    private readonly kind: MockSessionErrorOptions["kind"];

    constructor(message: string, options: MockSessionErrorOptions = {}) {
      super(message);
      this.kind = options.kind;
      this.retryable = options.retryable ?? true;
    }

    isNotFound(): boolean {
      return this.kind === "resource_not_found";
    }

    isClientRequestError(): boolean {
      return (
        this.kind === "resource_not_found" ||
        this.kind === "client_request_error"
      );
    }
  }

  class MockWHEPSession {
    private readonly record: MockSessionRecord;

    constructor({ callbacks = {} }: { callbacks?: MockCallbacks } = {}) {
      const snapshot: WHEPSessionSnapshot = {
        connectionState: "connecting",
        expectedRemoteTrackCount: 1,
        hasStream: false,
        iceConnectionState: "checking",
        liveTrackCount: 0,
        mutedTrackCount: 0,
        remoteTrackCount: 0,
        signalingState: "stable",
        status: "connecting",
      };
      this.record = {
        callbacks,
        disposeCount: 0,
        disposeOptions: [],
        emitStatus: (status) => {
          this.record.snapshot = {
            ...this.record.snapshot,
            connectionState:
              status === "connected"
                ? "connected"
                : status === "failed"
                  ? "failed"
                  : "connecting",
            hasStream:
              status === "connected" ? this.record.snapshot.hasStream : false,
            iceConnectionState:
              status === "connected"
                ? "connected"
                : status === "failed"
                  ? "failed"
                  : status === "disconnected"
                    ? "disconnected"
                    : "checking",
            status,
          };
          this.record.callbacks.onStatusChange?.(status);
        },
        emitStream: (hasStream) => {
          this.record.snapshot = { ...this.record.snapshot, hasStream };
          this.record.callbacks.onStreamChange?.(hasStream);
        },
        getSnapshot: () => this.record.snapshot,
        getStatsCallCount: () => this.record.statsCallCount,
        receiverStats: [],
        statsCallCount: 0,
        statsPromise: null,
        rejectStart: () => undefined,
        resolveStart: () => undefined,
        startSignal: null,
        snapshot,
      };
      mockSessions.push(this.record);
    }

    dispose(options?: { notifyServer?: boolean }): Promise<void> {
      this.record.disposeCount += 1;
      this.record.disposeOptions.push(options ?? {});
      return Promise.resolve();
    }

    getInboundReceiverStats(): Promise<WHEPInboundReceiverStat[]> {
      this.record.statsCallCount += 1;
      return (
        this.record.statsPromise ?? Promise.resolve(this.record.receiverStats)
      );
    }

    getSnapshot(): WHEPSessionSnapshot {
      return this.record.snapshot;
    }

    start(signal: AbortSignal): Promise<MockStartResult> {
      this.record.startSignal = signal;
      return new Promise((resolve, reject) => {
        this.record.rejectStart = reject;
        this.record.resolveStart = (result) => {
          resolve(result ?? { isErr: () => false });
        };
      });
    }
  }

  return {
    WHEPSession: MockWHEPSession,
    WHEPSessionError: MockWHEPSessionError,
  };
});

import {
  WHEPPlaybackController,
  createDefaultSnapshot,
  type WHEPPlaybackControllerSnapshot,
} from "./WHEPPlaybackController";
import { WHEPSessionError } from "./WHEPClient";

function getMockSession(index: number): MockSessionRecord {
  const session = mockSessions[index];
  if (!session)
    throw new Error(`Missing mock WHEP session at index ${String(index)}`);
  return session;
}

function readSnapshot(
  controller: WHEPPlaybackController,
): WHEPPlaybackControllerSnapshot {
  let snapshot = createDefaultSnapshot();
  const subscriber = (next: WHEPPlaybackControllerSnapshot) => {
    snapshot = next;
  };
  controller.setSnapshotSubscriber(subscriber);
  controller.unsetSnapshotSubscriber(subscriber);
  return snapshot;
}

function makeVideo(): HTMLVideoElement {
  return document.createElement("video");
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function connectMockSession(
  controller: WHEPPlaybackController,
  resourceUserId = "stream-a",
): Promise<MockSessionRecord> {
  controller.attachVideoElement(makeVideo());
  controller.load(resourceUserId);
  const session = getMockSession(mockSessions.length - 1);
  session.emitStatus("connected");
  session.resolveStart();
  await flushPromises();
  return session;
}

describe("WHEPPlaybackController", () => {
  beforeEach(() => {
    mockSessions.length = 0;
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("aborts an in-flight attempt before starting its replacement", async () => {
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());

    controller.load("stream-a");
    const firstSession = getMockSession(0);
    const firstSignal = firstSession.startSignal;
    if (!firstSignal) throw new Error("First mock session did not start");

    controller.load("stream-b");
    const secondSession = getMockSession(1);
    const secondSignal = secondSession.startSignal;
    if (!secondSignal) throw new Error("Second mock session did not start");

    expect(firstSignal.aborted).toBe(true);
    expect(firstSession.disposeCount).toBe(1);
    expect(firstSession.disposeOptions).toEqual([{ notifyServer: true }]);
    expect(secondSignal.aborted).toBe(false);
    expect(readSnapshot(controller).isLoading).toBe(true);

    firstSession.resolveStart();
    await flushPromises();
    expect(readSnapshot(controller).isLoading).toBe(true);
    controller.disconnect();
    expect(secondSignal.aborted).toBe(true);
    secondSession.resolveStart();
    await flushPromises();
    expect(readSnapshot(controller)).toEqual(createDefaultSnapshot());
    controller.dispose();
  });

  it("propagates unexpected rejections from a session start attempt", async () => {
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    const starting = controller.load("stream-a");
    getMockSession(0).rejectStart(new Error("unexpected start failure"));

    await expect(starting).rejects.toThrow("unexpected start failure");
    expect(readSnapshot(controller).isLoading).toBe(false);
    controller.dispose();
  });

  it("ignores blank resources and loads once a video element is attached", () => {
    const controller = new WHEPPlaybackController();
    controller.load("   ");
    expect(mockSessions).toHaveLength(0);
    expect(readSnapshot(controller)).toEqual(createDefaultSnapshot());

    controller.load("stream-a");
    expect(mockSessions).toHaveLength(0);
    controller.attachVideoElement(makeVideo());
    expect(mockSessions).toHaveLength(1);
    expect(getMockSession(0).startSignal?.aborted).toBe(false);
    controller.dispose();
  });

  it("queues attempts until a video is attached and trims the resource id", () => {
    const controller = new WHEPPlaybackController();
    controller.load("  stream-a  ");
    expect(readSnapshot(controller)).toEqual({
      isLoading: true,
      playbackState: {
        connectionStatus: "connecting",
        hasStream: false,
        phase: "connecting",
        resourceUserId: "stream-a",
        retryCount: 0,
      },
    });
    controller.attachVideoElement(null);
    expect(mockSessions).toHaveLength(0);

    controller.attachVideoElement(makeVideo());
    expect(mockSessions).toHaveLength(1);
    expect(readSnapshot(controller).playbackState.resourceUserId).toBe(
      "stream-a",
    );
    controller.dispose();
  });

  it("does not start a session when a video attaches without a pending load", async () => {
    const controller = new WHEPPlaybackController();

    await expect(controller.attachVideoElement(makeVideo())).resolves.toBe(
      undefined,
    );

    expect(mockSessions).toHaveLength(0);
    expect(readSnapshot(controller)).toEqual(createDefaultSnapshot());
    controller.dispose();
  });

  it("reports loading and playback snapshots to the current subscriber", () => {
    const controller = new WHEPPlaybackController();
    const subscriber =
      vi.fn<(snapshot: WHEPPlaybackControllerSnapshot) => void>();
    controller.setSnapshotSubscriber(subscriber);
    expect(subscriber).toHaveBeenLastCalledWith(createDefaultSnapshot());
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    expect(subscriber.mock.calls.at(-1)?.[0]).toMatchObject({
      isLoading: true,
      playbackState: {
        connectionStatus: "connecting",
        phase: "connecting",
        resourceUserId: "stream-a",
      },
    });

    controller.unsetSnapshotSubscriber(
      vi.fn<(snapshot: WHEPPlaybackControllerSnapshot) => void>(),
    );
    getMockSession(0).resolveStart();
    controller.unsetSnapshotSubscriber(subscriber);
    const callsBeforeResolve = subscriber.mock.calls.length;
    controller.disconnect();
    expect(subscriber).toHaveBeenCalledTimes(callsBeforeResolve);
    controller.dispose();
  });

  it("only unsubscribes the exact snapshot callback", () => {
    const controller = new WHEPPlaybackController();
    const subscriber =
      vi.fn<(snapshot: WHEPPlaybackControllerSnapshot) => void>();
    const otherSubscriber =
      vi.fn<(snapshot: WHEPPlaybackControllerSnapshot) => void>();
    controller.setSnapshotSubscriber(subscriber);
    controller.unsetSnapshotSubscriber(otherSubscriber);
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");

    const latestSnapshot = subscriber.mock.lastCall?.[0];
    expect(latestSnapshot?.isLoading).toBe(true);
    expect(latestSnapshot?.playbackState).toMatchObject({
      phase: "connecting",
      resourceUserId: "stream-a",
    });
    expect(otherSubscriber).not.toHaveBeenCalled();

    controller.unsetSnapshotSubscriber(subscriber);
    const callsAfterUnsubscribe = subscriber.mock.calls.length;
    controller.disconnect();
    expect(subscriber).toHaveBeenCalledTimes(callsAfterUnsubscribe);
    controller.dispose();
  });

  it.each([
    ["resource_not_found", true, "ended"],
    ["client_request_error", true, "error"],
    ["server_request_error", true, "error"],
    ["unexpected_response", false, "error"],
  ] as const)(
    "maps initial %s failures to a terminal state",
    async (kind, retryable, phase) => {
      const controller = new WHEPPlaybackController();
      const errorSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      let snapshot = createDefaultSnapshot();
      controller.setSnapshotSubscriber((next) => {
        snapshot = next;
      });
      controller.attachVideoElement(makeVideo());
      controller.load("stream-a");
      getMockSession(0).resolveStart({
        error: new WHEPSessionError("initial error", {
          kind,
          responseText: undefined,
          retryable,
          stage: "post",
        }),
        isErr: () => true,
      });
      await flushPromises();

      expect(snapshot).toMatchObject({
        isLoading: false,
        playbackState: {
          connectionStatus: phase === "ended" ? "disconnected" : "failed",
          hasStream: false,
          phase,
          resourceUserId: "stream-a",
          retryCount: 0,
        },
      });
      expect(errorSpy).toHaveBeenCalledTimes(phase === "error" ? 1 : 0);
      expect(errorSpy.mock.calls[0]?.[0]).toBe(
        phase === "error" ? "WHEP playback failed:" : undefined,
      );
      controller.dispose();
    },
  );

  it("disconnects, aborts and disposes active work, then restores the idle snapshot", async () => {
    const controller = new WHEPPlaybackController();
    let snapshot = createDefaultSnapshot();
    controller.setSnapshotSubscriber((next) => {
      snapshot = next;
    });
    controller.attachVideoElement(makeVideo());
    const starting = controller.load("stream-a");
    const session = getMockSession(0);

    controller.disconnect();

    expect(session.startSignal?.aborted).toBe(true);
    expect(session.disposeCount).toBe(1);
    expect(session.disposeOptions).toEqual([{ notifyServer: true }]);
    expect(snapshot).toEqual(createDefaultSnapshot());
    session.resolveStart();
    await expect(starting).resolves.toBeUndefined();
    controller.dispose();
  });

  it("does not load after disposal and disposes idempotently", () => {
    const controller = new WHEPPlaybackController();
    controller.dispose();
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    controller.disconnect();
    controller.dispose();
    expect(mockSessions).toHaveLength(0);
    expect(readSnapshot(controller)).toEqual(createDefaultSnapshot());
  });

  it("does not emit snapshots after disposal even if a new subscriber is set", () => {
    const controller = new WHEPPlaybackController();
    controller.dispose();
    const subscriber =
      vi.fn<(snapshot: WHEPPlaybackControllerSnapshot) => void>();

    controller.setSnapshotSubscriber(subscriber);
    const initialCalls = subscriber.mock.calls.length;
    controller.disconnect();

    expect(subscriber).toHaveBeenCalledTimes(initialCalls);
    controller.dispose();
  });

  it("ignores callbacks from a stale session after loading another stream", async () => {
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    controller.load("first");
    const staleSession = getMockSession(0);
    staleSession.resolveStart();
    await flushPromises();

    controller.load("second");
    const replacementSnapshot = readSnapshot(controller);
    staleSession.emitStatus("connected");
    staleSession.emitStream(true);

    expect(readSnapshot(controller)).toEqual(replacementSnapshot);
    expect(replacementSnapshot.playbackState.resourceUserId).toBe("second");
    getMockSession(1).resolveStart();
    await flushPromises();
    controller.dispose();
  });

  it("marks a session connected and updates its visible stream state", async () => {
    const controller = new WHEPPlaybackController();
    let snapshot = createDefaultSnapshot();
    controller.setSnapshotSubscriber((next) => {
      snapshot = next;
    });
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);
    session.emitStatus("connected");

    expect(snapshot).toMatchObject({
      isLoading: true,
      playbackState: {
        connectionStatus: "connected",
        hasStream: false,
        phase: "connected",
      },
    });
    session.emitStream(true);
    expect(snapshot.playbackState).toMatchObject({
      hasStream: true,
      phase: "connected",
    });
    session.resolveStart();
    await flushPromises();
    expect(snapshot.isLoading).toBe(false);
    controller.dispose();
  });

  it("keeps pre-connection failures inside the connecting attempt", async () => {
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);

    session.emitStatus("failed");
    expect(readSnapshot(controller)).toMatchObject({
      isLoading: true,
      playbackState: {
        connectionStatus: "failed",
        phase: "connecting",
        retryCount: 0,
      },
    });
    session.emitStatus("connecting");
    expect(readSnapshot(controller).playbackState).toMatchObject({
      connectionStatus: "connecting",
      phase: "connecting",
    });

    session.resolveStart();
    await flushPromises();
    expect(readSnapshot(controller).isLoading).toBe(false);
    expect(readSnapshot(controller).playbackState).toMatchObject({
      connectionStatus: "connecting",
      phase: "connecting",
    });
    expect(mockSessions).toHaveLength(1);
    controller.dispose();
  });

  it("ignores stream changes before connection and cancels recovery if it reconnects", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);

    session.emitStream(true);
    expect(readSnapshot(controller).playbackState.hasStream).toBe(false);
    session.emitStatus("connected");
    session.resolveStart();
    await flushPromises();
    expect(readSnapshot(controller).playbackState.hasStream).toBe(true);

    session.emitStatus("disconnected");
    expect(readSnapshot(controller).playbackState.phase).toBe("reconnecting");
    session.emitStream(true);
    expect(readSnapshot(controller).playbackState).toMatchObject({
      hasStream: false,
      phase: "reconnecting",
    });
    session.emitStatus("connected");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockSessions).toHaveLength(1);
    expect(readSnapshot(controller).playbackState.phase).toBe("connected");
    controller.dispose();
  });

  it("recovers a stable failed connection after its grace timer", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    const snapshots: WHEPPlaybackControllerSnapshot[] = [];
    controller.setSnapshotSubscriber((snapshot) => {
      snapshots.push(snapshot);
    });
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);
    session.emitStatus("connected");
    session.resolveStart();
    await flushPromises();
    session.emitStatus("failed");
    expect(snapshots.at(-1)?.playbackState.phase).toBe("reconnecting");

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.runOnlyPendingTimersAsync();

    expect(session.disposeCount).toBe(1);
    expect(snapshots.at(-1)?.playbackState.phase).toBe("reconnecting");
    expect(mockSessions).toHaveLength(2);
    expect(getMockSession(1).startSignal?.aborted).toBe(false);
    controller.dispose();
  });

  it("coalesces disconnected and failed callbacks into one recovery attempt", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    const session = await connectMockSession(controller);

    session.emitStatus("disconnected");
    session.emitStatus("failed");
    expect(readSnapshot(controller).playbackState).toMatchObject({
      connectionStatus: "disconnected",
      hasStream: false,
      phase: "reconnecting",
    });
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(3_000);
    await vi.runOnlyPendingTimersAsync();

    expect(session.disposeCount).toBe(1);
    expect(mockSessions).toHaveLength(2);
    expect(readSnapshot(controller).playbackState.retryCount).toBe(1);
    controller.dispose();
  });

  it("resets retry state when a retry reconnects successfully", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    const initial = await connectMockSession(controller);
    initial.emitStatus("disconnected");
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.runOnlyPendingTimersAsync();

    const retry = getMockSession(1);
    retry.emitStatus("connected");
    retry.resolveStart();
    await flushPromises();

    expect(readSnapshot(controller).playbackState).toEqual({
      connectionStatus: "connected",
      hasStream: false,
      phase: "connected",
      resourceUserId: "stream-a",
      retryCount: 0,
    });
    controller.dispose();
  });

  it.each([
    ["client error", "client_request_error", true, "error"],
    ["non-retryable server error", "server_request_error", false, "error"],
    ["transient server error", "server_request_error", true, "reconnecting"],
  ] as const)(
    "applies retry disposition to a %s",
    async (_label, kind, retryable, phase) => {
      vi.useFakeTimers();
      const controller = new WHEPPlaybackController();
      const initial = await connectMockSession(controller);
      initial.emitStatus("failed");
      await vi.advanceTimersByTimeAsync(3_000);
      await vi.runOnlyPendingTimersAsync();

      getMockSession(1).resolveStart({
        error: new WHEPSessionError("retry failed", {
          kind,
          responseText: undefined,
          retryable,
          stage: "post",
        }),
        isErr: () => true,
      });
      await flushPromises();

      const state = readSnapshot(controller).playbackState;
      expect(state).toEqual({
        connectionStatus: phase === "reconnecting" ? "connecting" : "failed",
        hasStream: false,
        phase,
        resourceUserId: "stream-a",
        retryCount: phase === "reconnecting" ? 1 : 0,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(mockSessions).toHaveLength(phase === "reconnecting" ? 3 : 2);
      controller.dispose();
    },
  );

  it("ends after the reconnect deadline when the resource was not found", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    const initial = await connectMockSession(controller);
    initial.emitStatus("disconnected");
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.runOnlyPendingTimersAsync();
    const reconnectDeadlineAt = Date.now() + WHEP_RECONNECT_WINDOW_MS;

    getMockSession(1).resolveStart({
      error: new WHEPSessionError("gone", {
        kind: "resource_not_found",
        responseText: undefined,
        retryable: false,
        stage: "post",
      }),
      isErr: () => true,
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    const secondRetry = getMockSession(2);
    vi.setSystemTime(reconnectDeadlineAt);
    secondRetry.resolveStart({
      error: new Error("still unavailable"),
      isErr: () => true,
    });
    await flushPromises();

    expect(readSnapshot(controller).playbackState).toMatchObject({
      connectionStatus: "disconnected",
      phase: "ended",
      retryCount: 0,
    });
    controller.dispose();
  });

  it("fails at the reconnect deadline when a retry remains unavailable", async () => {
    vi.useFakeTimers();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const controller = new WHEPPlaybackController();
    const initial = await connectMockSession(controller);

    initial.emitStatus("disconnected");
    await vi.advanceTimersByTimeAsync(3_000);
    const reconnectDeadlineAt = Date.now() + WHEP_RECONNECT_WINDOW_MS;
    await vi.runOnlyPendingTimersAsync();
    vi.setSystemTime(reconnectDeadlineAt);
    getMockSession(1).resolveStart({
      error: new Error("still unavailable"),
      isErr: () => true,
    });
    await flushPromises();

    expect(readSnapshot(controller).playbackState).toMatchObject({
      connectionStatus: "failed",
      phase: "error",
      retryCount: 0,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "WHEP playback failed:",
      expect.objectContaining({ message: "WHEP reconnect window expired" }),
    );
    expect(mockSessions).toHaveLength(2);
    controller.dispose();
  });

  it("finalizes a queued retry whose timer fires after its deadline", async () => {
    vi.useFakeTimers();
    const errorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const controller = new WHEPPlaybackController();
    const initial = await connectMockSession(controller);
    initial.emitStatus("disconnected");
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.runOnlyPendingTimersAsync();
    const reconnectDeadlineAt = Date.now() + WHEP_RECONNECT_WINDOW_MS;
    getMockSession(1).resolveStart({
      error: new Error("temporary"),
      isErr: () => true,
    });
    await flushPromises();

    vi.setSystemTime(reconnectDeadlineAt - 1_000);
    vi.spyOn(Date, "now").mockReturnValue(reconnectDeadlineAt);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(readSnapshot(controller).playbackState).toMatchObject({
      connectionStatus: "failed",
      hasStream: false,
      phase: "error",
      resourceUserId: "stream-a",
      retryCount: 0,
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "WHEP playback failed:",
      expect.objectContaining({ message: "WHEP reconnect window expired" }),
    );
    controller.dispose();
  });

  it("cancels a queued retry when disconnected", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    const initial = await connectMockSession(controller);
    initial.emitStatus("failed");
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.runOnlyPendingTimersAsync();
    const retry = getMockSession(1);
    retry.resolveStart({
      error: new Error("temporary"),
      isErr: () => true,
    });
    await flushPromises();

    expect(mockSessions).toHaveLength(2);
    expect(readSnapshot(controller).playbackState.phase).toBe("reconnecting");
    controller.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockSessions).toHaveLength(2);
    expect(readSnapshot(controller)).toEqual(createDefaultSnapshot());
    controller.dispose();
  });

  it("uses the remaining reconnect window to cap the retry delay", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const controller = new WHEPPlaybackController();
    const initial = await connectMockSession(controller);
    initial.emitStatus("disconnected");
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.runOnlyPendingTimersAsync();

    getMockSession(1).resolveStart({
      error: new Error("temporary"),
      isErr: () => true,
    });
    await flushPromises();
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 1_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(mockSessions).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(mockSessions).toHaveLength(3);
    controller.dispose();
  });

  it("cancels recovery when a failed session returns to connecting", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    const session = await connectMockSession(controller);
    session.emitStatus("failed");
    session.emitStatus("connecting");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_000);

    expect(mockSessions).toHaveLength(1);
    expect(readSnapshot(controller).playbackState.phase).toBe("reconnecting");
    controller.dispose();
  });

  it("cancels recovery when disconnected during the recovery grace period", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    const session = await connectMockSession(controller);
    session.emitStatus("failed");
    expect(vi.getTimerCount()).toBe(1);

    controller.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(session.disposeCount).toBe(1);
    expect(mockSessions).toHaveLength(1);
    expect(readSnapshot(controller)).toEqual(createDefaultSnapshot());
    controller.dispose();
  });

  it("handles a session that reports connected in its start snapshot", async () => {
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);
    session.snapshot = {
      ...session.snapshot,
      hasStream: true,
      status: "connected",
    };
    session.resolveStart();
    await flushPromises();

    expect(readSnapshot(controller).playbackState).toMatchObject({
      hasStream: true,
      phase: "connected",
    });
    controller.dispose();
  });

  it("waits for expected receivers before monitoring RTP stalls", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);
    session.emitStatus("connected");
    session.resolveStart();
    await flushPromises();

    await vi.advanceTimersByTimeAsync(1_000);
    session.receiverStats = [
      { bytesReceived: 1, id: "video-mid", kind: "video" },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    for (let bytes = 2; bytes <= 6; bytes += 1) {
      session.receiverStats = [
        { bytesReceived: bytes, id: "video-mid", kind: "video" },
      ];
      // oxlint-disable-next-line eslint/no-await-in-loop -- Advance each timer after installing the next cumulative byte count.
      await vi.advanceTimersByTimeAsync(1_000);
    }
    for (let bytes = 7; bytes <= 17; bytes += 1) {
      session.receiverStats = [
        { bytesReceived: bytes, id: "video-mid", kind: "video" },
      ];
      // oxlint-disable-next-line eslint/no-await-in-loop -- Preserve one telemetry sample per monitor interval.
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(mockSessions).toHaveLength(1);
    controller.dispose();
  });

  it("cancels receiver discovery timeout when expected media appears", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    const session = await connectMockSession(controller);

    for (let bytesReceived = 1; bytesReceived <= 18; bytesReceived += 1) {
      session.receiverStats = [
        { bytesReceived, id: "video-mid", kind: "video" },
      ];
      // oxlint-disable-next-line eslint/no-await-in-loop -- Keep cumulative receiver samples synchronized with each one-second poll.
      await vi.advanceTimersByTimeAsync(1_000);
    }

    expect(session.disposeCount).toBe(0);
    expect(mockSessions).toHaveLength(1);
    expect(readSnapshot(controller).playbackState.phase).toBe("connected");
    controller.dispose();
  });

  it("waits for all expected receivers and treats a missing receiver as stalled", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);
    session.snapshot = { ...session.snapshot, expectedRemoteTrackCount: 2 };
    session.emitStatus("connected");
    session.resolveStart();
    await flushPromises();

    session.receiverStats = [{ bytesReceived: 10, id: "audio", kind: "audio" }];
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.disposeCount).toBe(0);

    session.receiverStats = [
      { bytesReceived: 10, id: "audio", kind: "audio" },
      { bytesReceived: 20, id: "video", kind: "video" },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    for (let tick = 0; tick < 3; tick += 1) {
      session.receiverStats = [
        { bytesReceived: 10 + tick, id: "audio", kind: "audio" },
      ];
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each missing-receiver sample represents one elapsed second.
      await vi.advanceTimersByTimeAsync(1_000);
    }
    await vi.runOnlyPendingTimersAsync();

    expect(session.disposeCount).toBe(1);
    expect(mockSessions).toHaveLength(2);
    controller.dispose();
  });

  it("does not start overlapping receiver-stat polls while a request is pending", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);
    session.emitStatus("connected");
    session.resolveStart();
    await flushPromises();

    let resolveStats: ((stats: WHEPInboundReceiverStat[]) => void) | undefined;
    session.statsPromise = new Promise((resolve) => {
      resolveStats = resolve;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(session.getStatsCallCount()).toBe(1);

    resolveStats?.([]);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.getStatsCallCount()).toBe(2);
    controller.dispose();
  });

  it("ignores a receiver-stat result that resolves after monitor cleanup", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);
    session.emitStatus("connected");
    session.resolveStart();
    await flushPromises();

    let resolveStats: ((stats: WHEPInboundReceiverStat[]) => void) | undefined;
    session.statsPromise = new Promise((resolve) => {
      resolveStats = resolve;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.getStatsCallCount()).toBe(1);

    controller.disconnect();
    resolveStats?.([{ bytesReceived: 1, id: "video", kind: "video" }]);
    await flushPromises();

    expect(readSnapshot(controller)).toEqual(createDefaultSnapshot());
    expect(mockSessions).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });

  it("ignores pending receiver stats after established-session recovery begins", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    const session = await connectMockSession(controller);
    session.receiverStats = [{ bytesReceived: 10, id: "video", kind: "video" }];
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(2_000);

    let resolveStats: ((stats: WHEPInboundReceiverStat[]) => void) | undefined;
    session.statsPromise = new Promise((resolve) => {
      resolveStats = resolve;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    session.emitStatus("failed");
    resolveStats?.([]);
    await flushPromises();

    expect(session.disposeCount).toBe(0);
    expect(mockSessions).toHaveLength(1);
    expect(readSnapshot(controller).playbackState).toMatchObject({
      connectionStatus: "failed",
      hasStream: false,
      phase: "reconnecting",
    });
    controller.dispose();
  });

  it("reconnects after receiver bytes stop advancing", async () => {
    vi.useFakeTimers();
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);
    session.emitStatus("connected");
    session.resolveStart();
    await flushPromises();
    session.receiverStats = [
      { bytesReceived: 10, id: "video-mid", kind: "video" },
    ];

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.runOnlyPendingTimersAsync();

    expect(session.disposeCount).toBe(1);
    expect(mockSessions).toHaveLength(2);
    controller.dispose();
  });

  it("discovery timeout causes an immediate reconnect if expected receivers never appear", async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(window, "setTimeout");
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);
    session.snapshot = { ...session.snapshot, expectedRemoteTrackCount: 0 };
    session.emitStatus("connected");
    session.resolveStart();
    await flushPromises();

    await vi.advanceTimersByTimeAsync(15_000);
    expect(timeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 0);
    await vi.runOnlyPendingTimersAsync();

    expect(session.disposeCount).toBe(1);
    expect(mockSessions).toHaveLength(2);
    controller.dispose();
  });

  it("ignores a queued discovery timeout after expected receivers appear", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    let discoveryTimeoutId: number | undefined;
    const originalSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation((handler, timeout) => {
      const timerId = originalSetTimeout(handler, timeout);
      if (timeout === WHEP_TRACK_DISCOVERY_GRACE_MS) {
        discoveryTimeoutId = timerId;
      }
      return timerId;
    });
    const controller = new WHEPPlaybackController();
    const session = await connectMockSession(controller);
    if (discoveryTimeoutId === undefined) {
      throw new Error("Expected a receiver discovery timer id");
    }
    const originalClearTimeout = window.clearTimeout.bind(window);
    vi.spyOn(window, "clearTimeout").mockImplementation((timerId) => {
      if (timerId !== discoveryTimeoutId) originalClearTimeout(timerId);
    });

    session.receiverStats = [
      { bytesReceived: 1, id: "video-mid", kind: "video" },
    ];
    await vi.advanceTimersByTimeAsync(1_000);
    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(WHEP_TRACK_DISCOVERY_GRACE_MS);
    await vi.runOnlyPendingTimersAsync();

    expect(session.disposeCount).toBe(0);
    expect(mockSessions).toHaveLength(1);
    expect(readSnapshot(controller).playbackState.phase).toBe("connected");
    controller.dispose();
  });

  it("ignores a queued discovery timeout after its session is replaced", async () => {
    vi.useFakeTimers();
    let discoveryTimeoutId: number | undefined;
    const originalSetTimeout = window.setTimeout.bind(window);
    vi.spyOn(window, "setTimeout").mockImplementation((handler, timeout) => {
      const timerId = originalSetTimeout(handler, timeout);
      if (timeout === WHEP_TRACK_DISCOVERY_GRACE_MS) {
        discoveryTimeoutId = timerId;
      }
      return timerId;
    });
    const controller = new WHEPPlaybackController();
    const session = await connectMockSession(controller);
    if (discoveryTimeoutId === undefined) {
      throw new Error("Expected a receiver discovery timer id");
    }
    const originalClearTimeout = window.clearTimeout.bind(window);
    vi.spyOn(window, "clearTimeout").mockImplementation((timerId) => {
      if (timerId !== discoveryTimeoutId) originalClearTimeout(timerId);
    });

    controller.disconnect();
    await vi.advanceTimersByTimeAsync(WHEP_TRACK_DISCOVERY_GRACE_MS);
    await vi.runOnlyPendingTimersAsync();

    expect(session.disposeCount).toBe(1);
    expect(mockSessions).toHaveLength(1);
    expect(readSnapshot(controller)).toEqual(createDefaultSnapshot());
    controller.dispose();
  });

  it("pauses playback polling while hidden and resumes when visible", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const controller = new WHEPPlaybackController();
    controller.attachVideoElement(makeVideo());
    controller.load("stream-a");
    const session = getMockSession(0);
    session.emitStatus("connected");
    session.resolveStart();
    await flushPromises();

    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockSessions).toHaveLength(1);
    expect(session.getSnapshot().status).toBe("connected");

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.runOnlyPendingTimersAsync();
    expect(mockSessions).toHaveLength(2);
    controller.dispose();
  });

  it("does not create duplicate monitor intervals for repeated visibility events", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const controller = new WHEPPlaybackController();
    await connectMockSession(controller);
    const timerCount = vi.getTimerCount();
    expect(timerCount).toBe(2);

    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));

    expect(vi.getTimerCount()).toBe(timerCount);
    controller.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    controller.dispose();
  });

  it("stops its interval while hidden and restarts it when the page becomes visible", async () => {
    vi.useFakeTimers();
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("visible");
    const controller = new WHEPPlaybackController();
    const session = await connectMockSession(controller);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.getStatsCallCount()).toBe(1);

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(session.getStatsCallCount()).toBe(1);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.getStatsCallCount()).toBe(2);
    controller.disconnect();
    expect(session.disposeCount).toBe(1);
    controller.dispose();
  });

  it("clears media monitoring timers and its visibility listener on disconnect", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const removeListener = vi.spyOn(document, "removeEventListener");
    const controller = new WHEPPlaybackController();
    await connectMockSession(controller);

    expect(vi.getTimerCount()).toBe(2);
    controller.disconnect();
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    controller.dispose();
  });

  it("disposes active playback and its timers when disposed", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const removeListener = vi.spyOn(document, "removeEventListener");
    const controller = new WHEPPlaybackController();
    const session = await connectMockSession(controller);

    controller.dispose();

    expect(session.disposeCount).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(removeListener).toHaveBeenCalledWith(
      "visibilitychange",
      expect.any(Function),
    );
    await vi.advanceTimersByTimeAsync(20_000);
    expect(mockSessions).toHaveLength(1);
  });
});
