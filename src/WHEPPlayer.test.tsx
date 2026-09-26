// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultPlaybackState } from "./player/whep-playback";

const controllers = vi.hoisted(() => ({
  instances: [] as Array<{
    attachVideoElement: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
    setSnapshotSubscriber: ReturnType<typeof vi.fn>;
    unsetSnapshotSubscriber: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("./player/WHEPPlaybackController", () => ({
  WHEPPlaybackController: class {
    state = {
      attachVideoElement: vi.fn<(element: HTMLVideoElement | null) => void>(),
      load: vi.fn<(resource: string) => void>(),
      disconnect: vi.fn<() => void>(),
      dispose: vi.fn<() => void>(),
      setSnapshotSubscriber:
        vi.fn<(subscriber: (snapshot: unknown) => void) => void>(),
      unsetSnapshotSubscriber:
        vi.fn<(subscriber: (snapshot: unknown) => void) => void>(),
    };
    constructor() {
      controllers.instances.push(this.state);
    }
    attachVideoElement(value: HTMLVideoElement | null) {
      this.state.attachVideoElement(value);
    }
    load(value: string) {
      this.state.load(value);
    }
    disconnect() {
      this.state.disconnect();
    }
    dispose() {
      this.state.dispose();
    }
    setSnapshotSubscriber(value: (snapshot: unknown) => void) {
      this.state.setSnapshotSubscriber(value);
    }
    unsetSnapshotSubscriber(value: (snapshot: unknown) => void) {
      this.state.unsetSnapshotSubscriber(value);
    }
  },
}));
import { WHEPPlayer } from "./WHEPPlayer";

const snapshot = {
  isLoading: false,
  playbackState: createDefaultPlaybackState(),
};
afterEach(() => {
  cleanup();
  controllers.instances.length = 0;
});

describe("WHEP player view", () => {
  it("shows the idle placeholder and disconnects without a resource", async () => {
    const onSnapshotChange = vi.fn();
    const view = render(
      <WHEPPlayer
        resourceUserId={null}
        snapshot={snapshot}
        onSnapshotChange={onSnapshotChange}
      />,
    );
    const controller = controllers.instances[0];
    expect(controller).toBeDefined();
    expect(controller?.attachVideoElement).toHaveBeenCalledWith(
      screen.getByLabelText("ライブ配信プレイヤー"),
    );
    expect(controller?.disconnect).toHaveBeenCalledOnce();
    expect(
      screen.getByText("配信を選択して「Load」ボタンを押してください"),
    ).toBeTruthy();
    const subscriber = controller?.setSnapshotSubscriber.mock.calls[0]?.[0];
    expect(subscriber).toBeTypeOf("function");
    subscriber({
      isLoading: true,
      playbackState: createDefaultPlaybackState(),
    });
    expect(onSnapshotChange).toHaveBeenCalledWith({
      isLoading: true,
      playbackState: createDefaultPlaybackState(),
    });
    view.unmount();
    await Promise.resolve();
    expect(controller?.unsetSnapshotSubscriber).toHaveBeenCalledWith(
      subscriber,
    );
    expect(controller?.dispose).toHaveBeenCalledOnce();
  });

  it("loads a trimmed resource and shows video when media is available", () => {
    const activeSnapshot = {
      isLoading: false,
      playbackState: {
        connectionStatus: "connected" as const,
        hasStream: true,
        phase: "connected" as const,
        resourceUserId: "u",
        retryCount: 0 as const,
      },
    };
    render(
      <WHEPPlayer
        resourceUserId=" u "
        snapshot={activeSnapshot}
        onSnapshotChange={vi.fn()}
      />,
    );
    expect(controllers.instances[0]?.load).toHaveBeenCalledWith("u");
    const video = screen.getByLabelText(
      "ライブ配信プレイヤー",
    ) as HTMLVideoElement;
    expect(video.controls).toBe(true);
    expect(video.className).toContain("opacity-100");
    expect(screen.queryByText("映像を待機中...")).toBeNull();
  });

  it("rejects an unexpected resource change without remounting", () => {
    const view = render(
      <WHEPPlayer
        resourceUserId="first"
        snapshot={snapshot}
        onSnapshotChange={vi.fn()}
      />,
    );
    expect(() =>
      view.rerender(
        <WHEPPlayer
          resourceUserId="second"
          snapshot={snapshot}
          onSnapshotChange={vi.fn()}
        />,
      ),
    ).toThrow("WHEPPlayer resource changed without remounting");
  });
});
