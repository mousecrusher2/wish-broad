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
  results: [] as Array<
    | { isErr: () => boolean; error?: Error }
    | Promise<{ isErr: () => boolean; error?: Error }>
  >,
}));

vi.mock("./WHEPClient", () => {
  class MockWHEPSessionError extends Error {
    readonly kind: string;
    readonly retryable: boolean;
    constructor(
      message: string,
      options: { kind: string; retryable?: boolean },
    ) {
      super(message);
      this.kind = options.kind;
      this.retryable = options.retryable ?? true;
    }
    isNotFound() {
      return this.kind === "resource_not_found";
    }
    isClientRequestError() {
      return (
        this.kind === "resource_not_found" ||
        this.kind === "client_request_error"
      );
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
    controller.attachVideoElement(document.createElement("video"));
    controller.load("   ");
    expect(fake.sessions).toHaveLength(0);
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    expect(snapshots.at(-1)).toEqual(createDefaultSnapshot());
    controller.dispose();
    controller.attachVideoElement(document.createElement("video"));
    controller.load("user");
    controller.dispose();
    expect(fake.sessions).toHaveLength(0);
  });

  it("preserves a reconnecting state and schedules only one retry for repeated failures", async () => {
    const controller = startController();
    const first = getSession();
    connected(first);
    first.snapshot.status = "disconnected";
    first.callbacks.onStatusChange("disconnected");
    first.callbacks.onStatusChange("disconnected");
    expect(Reflect.get(controller, "recoveryTimerId")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.sessions).toHaveLength(2);
    expect(first.dispose).toHaveBeenCalledOnce();
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    expect(snapshots.at(-1)?.playbackState).toMatchObject({
      phase: "reconnecting",
      retryCount: 1,
    });
    controller.dispose();
  });

  it("retries if a previously required inbound receiver disappears", async () => {
    const controller = startController();
    const first = getSession();
    first.stats = [
      [{ id: "video", kind: "video", bytesReceived: 5 }],
      [{ id: "video", kind: "video", bytesReceived: 6 }],
      [],
      [],
      [],
    ];
    connected(first);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(fake.sessions).toHaveLength(2);
    controller.dispose();
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

  it("does not create a pending session after disconnecting before video attachment", () => {
    const controller = new WHEPPlaybackController();
    controller.load("user");
    controller.disconnect();
    controller.attachVideoElement(document.createElement("video"));
    expect(fake.sessions).toHaveLength(0);
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    expect(snapshots.at(-1)).toEqual(createDefaultSnapshot());
    controller.dispose();
  });

  it("keeps only the latest snapshot subscriber", () => {
    const controller = new WHEPPlaybackController();
    const oldSubscriber =
      vi.fn<(snapshot: ReturnType<typeof createDefaultSnapshot>) => void>();
    const currentSubscriber =
      vi.fn<(snapshot: ReturnType<typeof createDefaultSnapshot>) => void>();
    controller.setSnapshotSubscriber(oldSubscriber);
    controller.setSnapshotSubscriber(currentSubscriber);
    controller.unsetSnapshotSubscriber(oldSubscriber);
    controller.load("user");
    expect(oldSubscriber).toHaveBeenCalledOnce();
    expect(currentSubscriber).toHaveBeenCalledTimes(2);
    controller.unsetSnapshotSubscriber(currentSubscriber);
    controller.disconnect();
    expect(currentSubscriber).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it("updates a preconnection failure without treating it as an established stream", async () => {
    const controller = startController();
    const first = getSession();
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    first.snapshot.status = "failed";
    first.callbacks.onStatusChange("failed");
    expect(snapshots.at(-1)).toMatchObject({
      playbackState: {
        phase: "connecting",
        connectionStatus: "failed",
        resourceUserId: "user",
      },
    });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(fake.sessions).toHaveLength(1);
    controller.dispose();
  });

  it("expires repeated not-found retries as a stream end", async () => {
    const controller = startController();
    const first = getSession();
    connected(first);
    first.snapshot.status = "disconnected";
    first.callbacks.onStatusChange("disconnected");
    fake.results.push(
      ...Array.from({ length: 40 }, () => ({
        isErr: () => true,
        error: new WHEPSessionError("gone", {
          kind: "resource_not_found",
          responseText: "gone",
          stage: "post",
        }),
      })),
    );
    await vi.advanceTimersByTimeAsync(34_000);
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    expect(snapshots.at(-1)).toMatchObject({
      isLoading: false,
      playbackState: {
        phase: "ended",
        connectionStatus: "disconnected",
        resourceUserId: "user",
      },
    });
    expect(fake.sessions.length).toBeGreaterThan(2);
    controller.dispose();
  });

  it("expires repeated transport failures as a playback error", async () => {
    const controller = startController();
    const first = getSession();
    connected(first);
    first.snapshot.status = "failed";
    first.callbacks.onStatusChange("failed");
    fake.results.push(
      ...Array.from({ length: 40 }, () => ({
        isErr: () => true,
        error: new Error("temporary network failure"),
      })),
    );
    await vi.advanceTimersByTimeAsync(34_000);
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    expect(snapshots.at(-1)).toMatchObject({
      isLoading: false,
      playbackState: {
        phase: "error",
        connectionStatus: "failed",
        resourceUserId: "user",
      },
    });
    expect(console.error).toHaveBeenCalledWith(
      "WHEP playback failed:",
      expect.objectContaining({ message: "WHEP reconnect window expired" }),
    );
    controller.dispose();
  });

  it("ignores a late failure from an attempt replaced by another stream", async () => {
    let finishFirst:
      ((result: { isErr: () => boolean; error?: Error }) => void) | undefined;
    fake.results.push(
      new Promise((resolve) => {
        finishFirst = resolve;
      }),
    );
    const controller = startController();
    const first = getSession();
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    controller.load("second");
    expect(first.dispose).toHaveBeenCalledOnce();
    const second = getSession(1);
    finishFirst?.({ isErr: () => true, error: new Error("stale failure") });
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshots.at(-1)).toMatchObject({
      playbackState: { phase: "connecting", resourceUserId: "second" },
    });
    connected(second);
    expect(snapshots.at(-1)).toMatchObject({
      playbackState: { phase: "connected", resourceUserId: "second" },
    });
    controller.dispose();
  });

  it("recognizes a session that connected before start resolves", async () => {
    let finish: ((result: { isErr: () => boolean }) => void) | undefined;
    fake.results.push(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const controller = startController();
    const session = getSession();
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    session.snapshot.status = "connected";
    session.snapshot.hasStream = true;
    finish?.({ isErr: () => false });
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshots.at(-1)).toMatchObject({
      isLoading: false,
      playbackState: { phase: "connected", hasStream: true },
    });
    expect(Reflect.get(controller, "playbackMonitor")).not.toBeNull();
    controller.dispose();
  });

  it("ends a retry on a permanent client request error", async () => {
    const controller = startController();
    const first = getSession();
    connected(first);
    fake.results.push({
      isErr: () => true,
      error: new WHEPSessionError("forbidden", {
        kind: "client_request_error",
        responseText: "forbidden",
        retryable: false,
        stage: "post",
      }),
    });
    first.snapshot.status = "failed";
    first.callbacks.onStatusChange("failed");
    await vi.advanceTimersByTimeAsync(3_001);
    await vi.advanceTimersByTimeAsync(1);
    const snapshots: Array<ReturnType<typeof createDefaultSnapshot>> = [];
    controller.setSnapshotSubscriber((snapshot) => snapshots.push(snapshot));
    expect(fake.sessions).toHaveLength(2);
    expect(snapshots.at(-1)).toMatchObject({
      isLoading: false,
      playbackState: { phase: "error", connectionStatus: "failed" },
    });
    controller.dispose();
  });
});
