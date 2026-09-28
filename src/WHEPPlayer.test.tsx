// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WHEPPlaybackControllerSnapshot } from "./player/WHEPPlaybackController";
import { createDefaultSnapshot } from "./player/WHEPPlaybackController";
import { WHEPPlayer } from "./WHEPPlayer";

type SnapshotSubscriber = (snapshot: WHEPPlaybackControllerSnapshot) => void;
type ControllerRecord = {
  attachVideoElement: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  setSnapshotSubscriber: (subscriber: SnapshotSubscriber) => void;
  unsetSnapshotSubscriber: ReturnType<typeof vi.fn>;
  emit: (snapshot: WHEPPlaybackControllerSnapshot) => void;
};

const playerMocks = vi.hoisted<{ records: ControllerRecord[] }>(() => ({
  records: [],
}));
vi.mock("./player/WHEPPlaybackController", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./player/WHEPPlaybackController")>();
  class MockController {
    private subscriber: SnapshotSubscriber | null = null;
    readonly attachVideoElement =
      vi.fn<(videoElement: HTMLVideoElement | null) => void>();
    readonly disconnect = vi.fn<() => void>();
    readonly dispose = vi.fn<() => void>();
    readonly load = vi.fn<(resourceUserId: string) => void>();
    readonly unsetSnapshotSubscriber = vi.fn<
      (subscriber: SnapshotSubscriber) => void
    >((subscriber) => {
      if (this.subscriber === subscriber) this.subscriber = null;
    });
    constructor() {
      const record: ControllerRecord = {
        attachVideoElement: this.attachVideoElement,
        disconnect: this.disconnect,
        dispose: this.dispose,
        load: this.load,
        setSnapshotSubscriber: (subscriber) => {
          this.subscriber = subscriber;
          subscriber(actual.createDefaultSnapshot());
        },
        unsetSnapshotSubscriber: this.unsetSnapshotSubscriber,
        emit: (snapshot) => this.subscriber?.(snapshot),
      };
      playerMocks.records.push(record);
    }
    setSnapshotSubscriber(subscriber: SnapshotSubscriber): void {
      this.subscriber = subscriber;
      subscriber(actual.createDefaultSnapshot());
    }
  }
  return { ...actual, WHEPPlaybackController: MockController };
});

function latestController(): ControllerRecord {
  const record = playerMocks.records.at(-1);
  if (!record) throw new Error("Expected a playback controller");
  return record;
}

function props(
  resourceUserId: string | null = null,
  hasStream = false,
  onSnapshotChange = vi.fn<
    (snapshot: WHEPPlaybackControllerSnapshot) => void
  >(),
) {
  const snapshot = createDefaultSnapshot();
  snapshot.playbackState = {
    connectionStatus: "connected",
    hasStream,
    phase: "connected",
    resourceUserId: "alice",
    retryCount: 0,
  };
  return { onSnapshotChange, resourceUserId, snapshot };
}

describe("WHEPPlayer view", () => {
  beforeEach(() => {
    playerMocks.records.length = 0;
  });

  afterEach(cleanup);

  it("attaches its video and disconnects when no stream is selected", () => {
    const onSnapshotChange =
      vi.fn<(snapshot: WHEPPlaybackControllerSnapshot) => void>();
    const idleProps = props(null, false, onSnapshotChange);
    idleProps.snapshot = createDefaultSnapshot();
    render(<WHEPPlayer {...idleProps} />);

    expect(latestController().attachVideoElement).toHaveBeenCalledWith(
      screen.getByLabelText("ライブ配信プレイヤー"),
    );
    expect(latestController().disconnect).toHaveBeenCalledOnce();
    expect(latestController().load).not.toHaveBeenCalled();
    expect(onSnapshotChange).toHaveBeenCalledWith(createDefaultSnapshot());
    expect(
      screen.getByText("配信を選択して「Load」ボタンを押してください"),
    ).toBeTruthy();
  });

  it("trims selected resource ids and ignores blank ids", () => {
    const { unmount } = render(<WHEPPlayer {...props(" alice ")} />);
    expect(latestController().load).toHaveBeenCalledWith("alice");
    unmount();

    render(<WHEPPlayer {...props("   ")} />);
    expect(latestController().load).not.toHaveBeenCalled();
  });

  it("shows video controls only after a stream is available", () => {
    const { rerender } = render(<WHEPPlayer {...props("alice", false)} />);
    const video =
      screen.getByLabelText<HTMLVideoElement>("ライブ配信プレイヤー");
    expect(video.controls).toBe(false);
    expect(video.className).toContain("opacity-0");
    expect(screen.getByText("映像を待機中...")).toBeTruthy();

    rerender(<WHEPPlayer {...props("alice", true)} />);
    expect(video.controls).toBe(true);
    expect(video.className).toContain("opacity-100");
    expect(screen.queryByText("映像を待機中...")).toBeNull();
  });

  it("rejects changing the selected stream without remounting", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { rerender } = render(<WHEPPlayer {...props("alice")} />);

    expect(() => {
      rerender(<WHEPPlayer {...props("bob")} />);
    }).toThrow("WHEPPlayer resource changed without remounting");
  });

  it("unsubscribes on cleanup and defers final disposal for Strict Mode", async () => {
    const playerProps = props("alice");
    const { unmount } = render(
      <StrictMode>
        <WHEPPlayer {...playerProps} />
      </StrictMode>,
    );
    expect(playerMocks.records.length).toBeGreaterThan(0);
    const controller = playerMocks.records.find(
      (record) => record.load.mock.calls.length > 0,
    );
    expect(controller).toBeDefined();
    if (!controller)
      throw new Error("Expected the committed controller to load playback");
    expect(controller.load).toHaveBeenCalledWith("alice");
    expect(controller.dispose).not.toHaveBeenCalled();

    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(controller.unsetSnapshotSubscriber).toHaveBeenCalled();
    expect(controller.dispose).toHaveBeenCalledOnce();
  });

  it("forwards controller snapshot updates to the parent callback", () => {
    const onSnapshotChange =
      vi.fn<(snapshot: WHEPPlaybackControllerSnapshot) => void>();
    render(<WHEPPlayer {...props("alice", false, onSnapshotChange)} />);
    const nextSnapshot: WHEPPlaybackControllerSnapshot = {
      isLoading: false,
      playbackState: {
        connectionStatus: "failed",
        hasStream: false,
        phase: "error",
        resourceUserId: "alice",
        retryCount: 0,
      },
    };

    act(() => {
      latestController().emit(nextSnapshot);
    });
    expect(onSnapshotChange).toHaveBeenLastCalledWith(nextSnapshot);
  });
});
