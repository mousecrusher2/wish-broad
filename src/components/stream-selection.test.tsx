// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionControls } from "./ConnectionControls";
import { StreamSelection } from "./StreamSelection";
import {
  createDefaultPlaybackState,
  createPlaybackState,
  type WHEPPlaybackState,
} from "../player/whep-playback";

const streams = [
  { owner: { displayName: "Alice", userId: "alice" } },
  { owner: { displayName: "Bob", userId: "bob" } },
];

function selectionProps(
  overrides: Partial<ComponentProps<typeof StreamSelection>> = {},
) {
  return {
    error: null,
    isLoading: false,
    onLoadClick: vi.fn<() => void>(),
    onRefresh: vi.fn<() => void>(),
    onResourceChange: vi.fn<(resourceUserId: string) => void>(),
    playbackState: createDefaultPlaybackState(),
    resource: "",
    streams,
    streamsLoading: false,
    ...overrides,
  };
}

const states: WHEPPlaybackState[] = [
  createDefaultPlaybackState(),
  createPlaybackState("alice", "connecting", "connecting", 0),
  {
    connectionStatus: "connected",
    hasStream: true,
    phase: "connected",
    resourceUserId: "alice",
    retryCount: 0,
  },
  createPlaybackState("alice", "reconnecting", "disconnected", 2),
  {
    connectionStatus: "disconnected",
    hasStream: false,
    phase: "ended",
    resourceUserId: "alice",
    retryCount: 0,
  },
  {
    connectionStatus: "failed",
    hasStream: false,
    phase: "error",
    resourceUserId: "alice",
    retryCount: 0,
  },
];

describe("ConnectionControls", () => {
  afterEach(cleanup);

  it.each(states)(
    "renders a status style for phase $phase",
    (playbackState) => {
      const { container } = render(
        <ConnectionControls playbackState={playbackState} />,
      );
      const panel = container.firstElementChild;
      expect(panel).toBeTruthy();
      expect(panel?.className).toContain("rounded-2xl");
      expect(panel?.querySelector("span")?.className).toContain("rounded-full");
    },
  );

  it("leaves a stable blank status message while idle", () => {
    const { container } = render(
      <ConnectionControls playbackState={createDefaultPlaybackState()} />,
    );

    expect(container.textContent).toBe("\u00A0");
  });
});

describe("StreamSelection", () => {
  afterEach(cleanup);

  it("shows the empty state, prompts for a selection, and disables loading", () => {
    render(<StreamSelection {...selectionProps({ streams: [] })} />);

    expect(screen.getByText("現在利用可能な配信はありません")).toBeTruthy();
    expect(screen.getByText("配信を選択してください")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Load" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("marks the selected stream and reports unknown selected ids", () => {
    const { rerender } = render(
      <StreamSelection {...selectionProps({ resource: "alice" })} />,
    );

    expect(
      screen.getByRole<HTMLInputElement>("radio", { name: "Aliceの配信を選択" })
        .checked,
    ).toBe(true);
    expect(screen.getByText(/選択中:/u).textContent).toBe("選択中: Alice");
    expect(
      screen.getByRole("radio", { name: "Aliceの配信を選択" }).closest("label")
        ?.className,
    ).toContain("border-cyan-400/60");
    expect(
      screen.getByRole("radio", { name: "Bobの配信を選択" }).closest("label")
        ?.className,
    ).toContain("border-white/10");

    rerender(
      <StreamSelection {...selectionProps({ resource: "removed-user" })} />,
    );
    expect(screen.getByText("不明な配信")).toBeTruthy();
  });

  it("forwards stream choice, load, and refresh actions", () => {
    const props = selectionProps({ resource: "alice" });
    render(<StreamSelection {...props} />);

    fireEvent.click(screen.getByRole("radio", { name: "Bobの配信を選択" }));
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    fireEvent.click(screen.getByRole("button", { name: "Load" }));

    expect(props.onResourceChange).toHaveBeenCalledWith("bob");
    expect(props.onRefresh).toHaveBeenCalledOnce();
    expect(props.onLoadClick).toHaveBeenCalledOnce();
  });

  it.each([
    [{ isLoading: true, resource: "alice" }, "読み込み中..."],
    [{ streamsLoading: true, resource: "alice" }, "Load"],
    [{ resource: "   " }, "Load"],
  ] as const)("disables load when %j", (overrides, buttonName) => {
    render(<StreamSelection {...selectionProps(overrides)} />);
    expect(
      screen.getByRole("button", { name: buttonName }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("shows stream errors and enables retry actions only when not loading", () => {
    const props = selectionProps({
      error: "temporary failure",
      streamsLoading: true,
    });
    render(<StreamSelection {...props} />);

    expect(screen.getByText("エラー: temporary failure")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Reload" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(props.onRefresh).toHaveBeenCalledOnce();
  });
});
