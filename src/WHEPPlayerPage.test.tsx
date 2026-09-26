// @vitest-environment jsdom
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { err, ok } from "neverthrow";
import { afterEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  streams: {
    status: "ready",
    streams: [{ owner: { userId: "u", displayName: "Alice" } }],
    refresh: vi.fn<() => void>(),
  } as {
    status: string;
    streams?: unknown[];
    error?: string | undefined;
    refresh: () => void;
  },
  user: null as unknown,
  revalidate: vi.fn<() => Promise<void>>(),
  playerRenders: vi.fn<(resource: string | null) => void>(),
  playerMounts: vi.fn<(resource: string | null) => void>(),
}));

vi.mock("./api", () => ({
  useLiveStreams: () => mock.streams,
  useSuspenseCurrentUser: () =>
    mock.user ?? ok({ userId: "u", displayName: "Alice" }),
  revalidateLiveStreams: mock.revalidate,
}));
vi.mock("./OBSStreamingInfo", () => ({
  OBSStreamingInfo: ({
    isOpen,
    onClose,
  }: {
    isOpen: boolean;
    onClose: () => void;
  }) =>
    isOpen ? (
      <dialog open>
        OBS settings<button onClick={onClose}>Close settings</button>
      </dialog>
    ) : null,
}));
vi.mock("./components/StreamSelection", () => ({
  StreamSelection: ({
    resource,
    onResourceChange,
    streams,
    error,
    streamsLoading,
    onLoadClick,
    onRefresh,
    playbackState,
  }: {
    resource: string;
    onResourceChange: (value: string) => void;
    streams: unknown[];
    error: string | null;
    streamsLoading: boolean;
    onLoadClick: () => void;
    onRefresh: () => void;
    playbackState: { phase: string };
  }) => (
    <div>
      <span data-testid="stream-state">
        {JSON.stringify({
          resource,
          streams,
          error,
          streamsLoading,
          phase: playbackState.phase,
        })}
      </span>
      <button onClick={() => onResourceChange(" u ")}>Select user</button>
      <button onClick={() => onResourceChange("   ")}>Clear user</button>
      <button onClick={onLoadClick}>Load selected</button>
      <button onClick={onRefresh}>Refresh streams</button>
    </div>
  ),
}));
vi.mock("./WHEPPlayer", () => ({
  WHEPPlayer: ({
    resourceUserId,
    onSnapshotChange,
  }: {
    resourceUserId: string | null;
    onSnapshotChange: (snapshot: unknown) => void;
  }) => {
    mock.playerRenders(resourceUserId);
    useEffect(() => {
      mock.playerMounts(resourceUserId);
    }, [resourceUserId]);
    return (
      <div data-testid="player">
        {resourceUserId ?? "no stream"}
        <button
          onClick={() =>
            onSnapshotChange({
              isLoading: false,
              playbackState: {
                connectionStatus: "disconnected",
                hasStream: false,
                phase: "ended",
                resourceUserId: "u",
                retryCount: 0,
              },
            })
          }
        >
          End playback
        </button>
        <button
          onClick={() =>
            onSnapshotChange({
              isLoading: false,
              playbackState: {
                connectionStatus: "connected",
                hasStream: true,
                phase: "connected",
                resourceUserId: "u",
                retryCount: 0,
              },
            })
          }
        >
          Resume playback
        </button>
      </div>
    );
  },
}));

import { WHEPPlayerPage } from "./WHEPPlayerPage";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mock.streams = {
    status: "ready",
    streams: [{ owner: { userId: "u", displayName: "Alice" } }],
    refresh: vi.fn(),
  };
  mock.user = null;
});

describe("player page", () => {
  it("greets the current user and opens and closes OBS settings", () => {
    render(<WHEPPlayerPage />);
    expect(screen.getByText("Alice")).toBeTruthy();
    expect(screen.getByText("Alice").parentElement?.textContent).toBe(
      "ようこそ、Alice さん",
    );
    expect(
      screen
        .getByRole("button", { name: "ログアウト" })
        .closest("form")
        ?.getAttribute("action"),
    ).toBe("/logout");
    const open = screen.getByRole("button", { name: "📺 OBS配信設定" });
    expect(open.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(open);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(open.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("supports a failing current-user lookup", () => {
    mock.user = err(new Error("offline"));
    render(<WHEPPlayerPage />);
    expect(screen.getByText("ユーザー情報を取得できません")).toBeTruthy();
  });

  it("selects a stream, remounts when loading it again, and refreshes when it ends", () => {
    render(<WHEPPlayerPage />);
    expect(screen.getByTestId("player").textContent).toContain("no stream");
    fireEvent.click(screen.getByRole("button", { name: "Select user" }));
    fireEvent.click(screen.getByRole("button", { name: "Load selected" }));
    expect(screen.getByTestId("player").textContent).toContain("u");
    expect(mock.playerRenders).toHaveBeenCalledWith("u");
    expect(mock.playerMounts.mock.calls.map(([resource]) => resource)).toEqual([
      null,
      "u",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "End playback" }));
    expect(mock.revalidate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "End playback" }));
    expect(mock.revalidate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Load selected" }));
    expect(
      mock.playerRenders.mock.calls.filter(([resource]) => resource === "u")
        .length,
    ).toBeGreaterThan(1);
    expect(mock.playerMounts.mock.calls.map(([resource]) => resource)).toEqual([
      null,
      "u",
      "u",
    ]);
  });

  it("only refreshes when a connected player first transitions to ended", () => {
    render(<WHEPPlayerPage />);
    fireEvent.click(screen.getByRole("button", { name: "Select user" }));
    fireEvent.click(screen.getByRole("button", { name: "Load selected" }));
    fireEvent.click(screen.getByRole("button", { name: "Resume playback" }));
    expect(mock.revalidate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "End playback" }));
    expect(mock.revalidate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Resume playback" }));
    fireEvent.click(screen.getByRole("button", { name: "End playback" }));
    expect(mock.revalidate).toHaveBeenCalledTimes(2);
  });

  it("does not load an empty stream selection", () => {
    render(<WHEPPlayerPage />);
    expect(
      JSON.parse(screen.getByTestId("stream-state").textContent ?? "{}")
        .resource,
    ).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Clear user" }));
    fireEvent.click(screen.getByRole("button", { name: "Load selected" }));
    expect(mock.playerMounts).toHaveBeenCalledExactlyOnceWith(null);
    expect(screen.getByTestId("player").textContent).toContain("no stream");
  });

  it.each([
    ["ready", [{ owner: { userId: "u" } }], null, false],
    ["loading", [{ owner: { userId: "stale" } }], null, true],
    ["refreshing", [{ owner: { userId: "u" } }], null, true],
    ["retrying", [{ owner: { userId: "stale" } }], "offline", true],
    ["error", [{ owner: { userId: "stale" } }], "offline", false],
  ] as const)(
    "maps the %s live-list status to the selector",
    (status, streams, error, streamsLoading) => {
      mock.streams = {
        status,
        streams: [...streams],
        error: error ?? undefined,
        refresh: vi.fn(),
      };
      render(<WHEPPlayerPage />);
      const state = JSON.parse(
        screen.getByTestId("stream-state").textContent ?? "{}",
      );
      expect(state).toMatchObject({
        streams: status === "ready" || status === "refreshing" ? streams : [],
        error,
        streamsLoading,
      });
    },
  );
});
