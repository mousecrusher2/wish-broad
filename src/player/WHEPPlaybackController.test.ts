import { beforeEach, describe, expect, it, vi } from "vitest";

type MockSessionRecord = {
  disposeCount: number;
  resolveStart: () => void;
  startSignal: AbortSignal | null;
};

const mockSessions = vi.hoisted<Array<MockSessionRecord>>(() => []);

vi.mock("./WHEPClient", () => {
  class MockWHEPSessionError extends Error {
    isNotFound(): boolean {
      return false;
    }
  }

  class MockStartResult {
    isErr(): false {
      return false;
    }
  }

  class MockWHEPSession {
    private readonly record: MockSessionRecord;

    constructor() {
      this.record = {
        disposeCount: 0,
        resolveStart: () => {},
        startSignal: null,
      };
      mockSessions.push(this.record);
    }

    dispose(): Promise<void> {
      this.record.disposeCount += 1;
      return Promise.resolve();
    }

    getInboundReceiverStats(): Promise<[]> {
      return Promise.resolve([]);
    }

    getSnapshot() {
      return {
        connectionState: "connecting",
        expectedRemoteTrackCount: 0,
        hasStream: false,
        iceConnectionState: "checking",
        liveTrackCount: 0,
        mutedTrackCount: 0,
        remoteTrackCount: 0,
        signalingState: "stable",
        status: "connecting",
      };
    }

    start(signal: AbortSignal): Promise<{ isErr: () => false }> {
      this.record.startSignal = signal;
      return new Promise((resolve) => {
        this.record.resolveStart = () => {
          resolve(new MockStartResult());
        };
      });
    }
  }

  return {
    WHEPSession: MockWHEPSession,
    WHEPSessionError: MockWHEPSessionError,
  };
});

import { WHEPPlaybackController } from "./WHEPPlaybackController";

function getMockSession(index: number): MockSessionRecord {
  const session = mockSessions[index];
  if (!session) {
    throw new Error(`Missing mock WHEP session at index ${String(index)}`);
  }
  return session;
}

function getStartSignal(session: MockSessionRecord): AbortSignal {
  if (!session.startSignal) {
    throw new Error("Mock WHEP session was not started");
  }
  return session.startSignal;
}

describe("WHEPPlaybackController", () => {
  beforeEach(() => {
    mockSessions.length = 0;
  });

  it("aborts an in-flight attempt before starting its replacement", async () => {
    const controller = new WHEPPlaybackController();
    expect(Reflect.set(controller, "videoElement", {})).toBe(true);

    controller.load("stream-a");
    const firstSession = getMockSession(0);
    const firstSignal = getStartSignal(firstSession);

    controller.load("stream-b");
    const secondSession = getMockSession(1);
    const secondSignal = getStartSignal(secondSession);

    expect(firstSignal.aborted).toBe(true);
    expect(firstSession.disposeCount).toBe(1);
    expect(secondSignal.aborted).toBe(false);

    firstSession.resolveStart();
    secondSession.resolveStart();
    await Promise.resolve();
    await Promise.resolve();

    controller.dispose();
  });
});
