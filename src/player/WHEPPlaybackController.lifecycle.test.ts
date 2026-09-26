// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type State = {
  callbacks: {
    onStatusChange: (status: string) => void;
    onStreamChange: (hasStream: boolean) => void;
  };
  resourceUserId: string;
  snapshot: {
    status: string;
    hasStream: boolean;
    expectedRemoteTrackCount: number;
  };
  dispose: (options?: unknown) => Promise<void>;
  stats: Array<Array<{ id: string; kind: string; bytesReceived: number }>>;
};

const fake = vi.hoisted(() => ({
  sessions: [] as State[],
  results: [] as Array<{ isErr: () => boolean; error?: Error }>,
}));

vi.mock("./WHEPClient", () => {
  class MockWHEPSessionError extends Error {
    constructor(
      message: string,
      readonly missing = false,
    ) {
      super(message);
    }
    isNotFound() {
      return this.missing;
    }
  }
  class MockWHEPSession {
    state: State;
    constructor(options: {
      callbacks: State["callbacks"];
      resourceUserId: string;
    }) {
      this.state = {
        callbacks: options.callbacks,
        resourceUserId: options.resourceUserId,
        snapshot: {
          status: "connecting",
          hasStream: false,
          expectedRemoteTrackCount: 1,
        },
        dispose: vi.fn(async () => undefined),
        stats: [],
      };
      fake.sessions.push(this.state);
    }
    start() {
      return Promise.resolve(fake.results.shift() ?? { isErr: () => false });
    }
    dispose(options: unknown) {
      return this.state.dispose(options);
    }
    getSnapshot() {
      return this.state.snapshot;
    }
    getInboundReceiverStats() {
      return Promise.resolve(this.state.stats.shift() ?? []);
    }
  }
  return {
    WHEPSession: MockWHEPSession,
    WHEPSessionError: MockWHEPSessionError,
  };
});

import {
  createDefaultSnapshot,
  WHEPPlaybackController,
} from "./WHEPPlaybackController";
import { WHEPSessionError } from "./WHEPClient";

function getSession(index = 0): State {
  const session = fake.sessions[index];
  if (!session) throw new Error(`Missing mock session ${index}`);
  return session;
}

function connected(session: State, hasStream = true) {
  session.snapshot.status = "connected";
  session.snapshot.hasStream = hasStream;
  session.callbacks.onStatusChange("connected");
}

function startController() {
  const controller = new WHEPPlaybackController();
  controller.attachVideoElement(document.createElement("video"));
  controller.load(" user ");
  return controller;
}

describe("playback lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    fake.sessions.length = 0;
    fake.results.length = 0;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("loads a pending request when a video element is attached", async () => {
    const controller = new WHEPPlaybackController();
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    const subscriber = (snapshot: ReturnType<typeof createDefaultSnapshot>) =>
      snapshots.push(snapshot);
    controller.setSnapshotSubscriber(subscriber);
    expect(snapshots[0]).toEqual(createDefaultSnapshot());
    controller.load("  user  ");
    expect(fake.sessions).toHaveLength(0);
    expect(snapshots.at(-1)).toMatchObject({
      isLoading: true,
      playbackState: { resourceUserId: "user", phase: "connecting" },
    });
    controller.attachVideoElement(document.createElement("video"));
    expect(getSession().resourceUserId).toBe("user");
    await Promise.resolve();
    expect(snapshots.at(-1)?.isLoading).toBe(false);
    controller.unsetSnapshotSubscriber(subscriber);
    controller.disconnect();
    expect(getSession().dispose).toHaveBeenCalledWith({ notifyServer: true });
    expect(snapshots.at(-1)?.playbackState.phase).toBe("connecting");
  });

  it("ignores blank loads and does not restart after disposal", () => {
    const controller = new WHEPPlaybackController();
    controller.load("   ");
    expect(fake.sessions).toHaveLength(0);
    controller.dispose();
    controller.attachVideoElement(document.createElement("video"));
    controller.load("user");
    controller.dispose();
    expect(fake.sessions).toHaveLength(0);
  });

  it("classifies an absent initial stream as ended and other failures as errors", async () => {
    fake.results.push({
      isErr: () => true,
      error: new WHEPSessionError("gone", {
        kind: "resource_not_found",
        responseText: "gone",
        stage: "post",
      }),
    });
    const missing = startController();
    await Promise.resolve();
    const seen: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    missing.setSnapshotSubscriber((snapshot) => seen.push(snapshot));
    expect(seen.at(-1)).toMatchObject({
      isLoading: false,
      playbackState: {
        phase: "ended",
        connectionStatus: "disconnected",
        hasStream: false,
      },
    });

    fake.results.push({ isErr: () => true, error: new Error("offline") });
    const error = startController();
    await Promise.resolve();
    const errors: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    error.setSnapshotSubscriber((snapshot) => errors.push(snapshot));
    expect(errors.at(-1)).toMatchObject({
      isLoading: false,
      playbackState: { phase: "error", connectionStatus: "failed" },
    });
    expect(console.error).toHaveBeenCalledWith(
      "WHEP playback failed:",
      expect.any(Error),
    );
  });

  it("tracks a connected stream and updates media availability", async () => {
    const controller = startController();
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    const session = getSession();
    connected(session, true);
    expect(snapshots.at(-1)).toMatchObject({
      playbackState: { phase: "connected", hasStream: true, retryCount: 0 },
    });
    session.snapshot.hasStream = false;
    session.callbacks.onStreamChange(false);
    expect(snapshots.at(-1)?.playbackState.hasStream).toBe(false);
    controller.disconnect();
    expect(snapshots.at(-1)).toEqual(createDefaultSnapshot());
    await Promise.resolve();
  });

  it("reconnects after a stable disconnected state and cancels recovery on connection", async () => {
    const controller = startController();
    const first = getSession();
    connected(first);
    first.snapshot.status = "disconnected";
    first.callbacks.onStatusChange("disconnected");
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    expect(snapshots.at(-1)).toMatchObject({
      playbackState: {
        phase: "reconnecting",
        connectionStatus: "disconnected",
      },
    });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(fake.sessions).toHaveLength(1);
    first.snapshot.status = "connected";
    first.callbacks.onStatusChange("connected");
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sessions).toHaveLength(1);
    first.snapshot.status = "failed";
    first.callbacks.onStatusChange("failed");
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(Reflect.get(controller, "reconnectDeadlineAt")).not.toBeNull();
    expect(fake.sessions).toHaveLength(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("retries when inbound receivers never appear", async () => {
    const controller = startController();
    const first = getSession();
    first.snapshot.expectedRemoteTrackCount = 2;
    connected(first);
    expect(document.visibilityState).toBe("visible");
    expect(Reflect.get(controller, "playbackMonitor")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sessions).toHaveLength(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("retries when inbound RTP byte counters stop progressing", async () => {
    const controller = startController();
    const first = getSession();
    first.stats = Array.from({ length: 6 }, () => [
      { id: "video", kind: "video", bytesReceived: 42 },
    ]);
    connected(first);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sessions).toHaveLength(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    controller.dispose();
  });

  it("keeps a healthy session when every inbound receiver advances", async () => {
    const controller = startController();
    const first = getSession();
    first.snapshot.expectedRemoteTrackCount = 2;
    first.stats = Array.from({ length: 8 }, (_, tick) => [
      { id: "video", kind: "video", bytesReceived: tick * 30 },
      { id: "audio", kind: "audio", bytesReceived: tick * 10 },
    ]);
    connected(first);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(fake.sessions).toHaveLength(1);
    expect(first.dispose).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("waits for all expected receivers, then starts the stall timer", async () => {
    const controller = startController();
    const first = getSession();
    first.snapshot.expectedRemoteTrackCount = 2;
    first.stats = [
      [{ id: "video", kind: "video", bytesReceived: 40 }],
      [{ id: "video", kind: "video", bytesReceived: 50 }],
      [
        { id: "video", kind: "video", bytesReceived: 60 },
        { id: "audio", kind: "audio", bytesReceived: 10 },
      ],
      [
        { id: "video", kind: "video", bytesReceived: 61 },
        { id: "audio", kind: "audio", bytesReceived: 11 },
      ],
    ];
    connected(first);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fake.sessions).toHaveLength(1);
    expect(first.dispose).not.toHaveBeenCalled();
    controller.dispose();
  });

  it("stops polling while the document is hidden and resumes when visible", async () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const controller = startController();
    const first = getSession();
    connected(first);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fake.sessions).toHaveLength(1);
    expect(first.stats).toEqual([]);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sessions).toHaveLength(2);
    controller.dispose();
  });

  it("ignores stale session callbacks after loading a replacement", async () => {
    const controller = startController();
    const first = getSession();
    connected(first);
    controller.load("other");
    const second = getSession(1);
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    first.callbacks.onStatusChange("failed");
    first.callbacks.onStreamChange(false);
    expect(snapshots.at(-1)?.playbackState).toMatchObject({
      phase: "connecting",
      resourceUserId: "other",
    });
    expect(first.dispose).toHaveBeenCalledOnce();
    connected(second);
    expect(snapshots.at(-1)?.playbackState).toMatchObject({
      phase: "connected",
      resourceUserId: "other",
    });
    controller.dispose();
    await Promise.resolve();
  });

  it("removes monitoring and timers on disconnect", async () => {
    const controller = startController();
    const first = getSession();
    connected(first);
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    controller.disconnect();
    expect(snapshots.at(-1)).toEqual(createDefaultSnapshot());
    expect(first.dispose).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(fake.sessions).toHaveLength(1);
    expect(Reflect.get(controller, "playbackMonitor")).toBeNull();
    controller.dispose();
  });
});
