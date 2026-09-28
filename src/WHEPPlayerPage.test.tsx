// @vitest-environment jsdom
// oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion, vitest/no-conditional-expect -- This page fixture tests every discriminated stream state and the mock hook must reproduce each variant.
import { useEffect } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Live, User } from "./types";

const pageMocks = vi.hoisted(() => ({
  liveState: {
    status: "ready",
    refresh: vi.fn<() => void>(),
    streams: [] as Live[],
  },
  revalidate: vi.fn<() => void>(),
  playerMounts: vi.fn<(resourceUserId: string | null) => void>(),
  playerUnmounts: vi.fn<() => void>(),
  suspendUser: false,
  userResult: null as unknown,
}));

vi.mock("./api", () => ({
  revalidateLiveStreams: pageMocks.revalidate,
  useLiveStreams: () => pageMocks.liveState,
  useSuspenseCurrentUser: () => {
    if (pageMocks.suspendUser) {
      // oxlint-disable-next-line typescript/only-throw-error -- Suspense is signaled by throwing a pending promise.
      throw new Promise<never>(() => {});
    }
    return pageMocks.userResult;
  },
}));
vi.mock("./WHEPPlayer", () => ({
  WHEPPlayer: ({
    onSnapshotChange,
    resourceUserId,
    snapshot,
  }: {
    onSnapshotChange: (snapshot: {
      isLoading: boolean;
      playbackState: {
        connectionStatus: "connected" | "disconnected";
        hasStream: false;
        phase: "connected" | "ended";
        resourceUserId: string;
        retryCount: 0;
      };
    }) => void;
    resourceUserId: string | null;
    snapshot: { playbackState: { phase: string } };
  }) => {
    useEffect(() => {
      pageMocks.playerMounts(resourceUserId);
      return () => {
        pageMocks.playerUnmounts();
      };
    }, [resourceUserId]);

    return (
      <div>
        <div data-testid="active-resource">{resourceUserId ?? "none"}</div>
        <div data-testid="player-phase">{snapshot.playbackState.phase}</div>
        <button
          onClick={() => {
            onSnapshotChange({
              isLoading: false,
              playbackState: {
                connectionStatus: "connected",
                hasStream: false,
                phase: "connected",
                resourceUserId: resourceUserId ?? "alice",
                retryCount: 0,
              },
            });
          }}
          type="button"
        >
          Connect playback
        </button>
        <button
          onClick={() => {
            onSnapshotChange({
              isLoading: false,
              playbackState: {
                connectionStatus: "disconnected",
                hasStream: false,
                phase: "ended",
                resourceUserId: resourceUserId ?? "alice",
                retryCount: 0,
              },
            });
          }}
          type="button"
        >
          End playback
        </button>
      </div>
    );
  },
}));
vi.mock("./OBSStreamingInfo", () => ({
  OBSStreamingInfo: ({
    isOpen,
    onClose,
  }: {
    isOpen: boolean;
    onClose: () => void;
  }) => (
    <div>
      <span data-testid="obs-open">{String(isOpen)}</span>
      <button onClick={onClose} type="button">
        Close settings
      </button>
    </div>
  ),
}));

import { WHEPPlayerPage } from "./WHEPPlayerPage";

describe("WHEPPlayerPage", () => {
  beforeEach(() => {
    pageMocks.liveState = {
      status: "ready",
      refresh: vi.fn<() => void>(),
      streams: [{ owner: { displayName: "Alice", userId: "alice" } }],
    };
    pageMocks.revalidate.mockReset();
    pageMocks.playerMounts.mockReset();
    pageMocks.playerUnmounts.mockReset();
    pageMocks.userResult = ok<User, Error>({
      displayName: "Alice",
      userId: "alice",
    });
    pageMocks.suspendUser = false;
  });

  afterEach(cleanup);

  it("greets the viewer, selects a live, loads it, and permits loading it again", () => {
    render(<WHEPPlayerPage />);

    expect(pageMocks.playerMounts).toHaveBeenCalledOnce();
    expect(pageMocks.playerMounts).toHaveBeenLastCalledWith(null);
    expect(screen.getByText("配信を選択してください")).toBeTruthy();
    expect(screen.getByText(/ようこそ/u).textContent).toBe(
      "ようこそ、Alice さん",
    );
    expect(screen.getByTestId("active-resource").textContent).toBe("none");
    fireEvent.click(screen.getByRole("radio", { name: "Aliceの配信を選択" }));
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(screen.getByTestId("active-resource").textContent).toBe("alice");
    expect(pageMocks.playerMounts).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(screen.getByTestId("active-resource").textContent).toBe("alice");
    expect(pageMocks.playerMounts).toHaveBeenCalledTimes(3);
    expect(pageMocks.playerUnmounts).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(pageMocks.playerMounts).toHaveBeenCalledTimes(4);
    expect(pageMocks.playerUnmounts).toHaveBeenCalledTimes(3);
  });

  it("trims resources and ignores blank load attempts", () => {
    pageMocks.liveState = {
      status: "ready",
      refresh: vi.fn<() => void>(),
      streams: [{ owner: { displayName: "Alice", userId: "  alice  " } }],
    };
    render(<WHEPPlayerPage />);

    fireEvent.click(screen.getByRole("radio", { name: "Aliceの配信を選択" }));
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(screen.getByTestId("active-resource").textContent).toBe("alice");

    pageMocks.liveState.streams = [];
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(screen.getByTestId("active-resource").textContent).toBe("alice");
  });

  it("refreshes the live list only when playback newly reaches ended", () => {
    render(<WHEPPlayerPage />);

    fireEvent.click(screen.getByRole("button", { name: "Connect playback" }));
    expect(screen.getByTestId("player-phase").textContent).toBe("connected");
    expect(pageMocks.revalidate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "End playback" }));
    expect(pageMocks.revalidate).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "End playback" }));

    expect(pageMocks.revalidate).toHaveBeenCalledOnce();
    expect(screen.getByTestId("player-phase").textContent).toBe("ended");
  });

  it("opens and closes OBS settings", () => {
    render(<WHEPPlayerPage />);

    expect(screen.getByTestId("obs-open").textContent).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /OBS配信設定/u }));
    expect(screen.getByTestId("obs-open").textContent).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(screen.getByTestId("obs-open").textContent).toBe("false");
  });

  it("shows unavailable user and suspense fallback states", () => {
    pageMocks.userResult = err(new Error("unavailable"));
    const { rerender } = render(<WHEPPlayerPage />);
    expect(screen.getByText("ユーザー情報を取得できません")).toBeTruthy();

    pageMocks.suspendUser = true;
    rerender(<WHEPPlayerPage />);
    expect(screen.getByText("ユーザー情報を確認中...")).toBeTruthy();
  });

  it.each([
    ["loading", [], null],
    ["ready", [{ owner: { displayName: "Alice", userId: "alice" } }], null],
    [
      "refreshing",
      [{ owner: { displayName: "Alice", userId: "alice" } }],
      null,
    ],
    ["error", [], "offline"],
    ["retrying", [], "offline"],
  ] as const)(
    "adapts the %s stream state for the selection panel",
    (status, liveStreams, error) => {
      pageMocks.liveState = {
        status,
        refresh: vi.fn<() => void>(),
        ...(status === "ready" || status === "refreshing"
          ? { streams: liveStreams }
          : {}),
        ...(status === "error" || status === "retrying" ? { error } : {}),
      } as unknown as typeof pageMocks.liveState;
      render(<WHEPPlayerPage />);

      if (error) {
        expect(screen.getByText(`エラー: ${error}`)).toBeTruthy();
        expect(
          screen
            .getByRole("button", { name: "Reload" })
            .hasAttribute("disabled"),
        ).toBe(status === "retrying");
      } else if (status === "refreshing") {
        expect(
          screen
            .getByRole("button", { name: "Reload" })
            .hasAttribute("disabled"),
        ).toBe(true);
        expect(
          screen.getByRole("radio", { name: "Aliceの配信を選択" }),
        ).toBeTruthy();
      } else if (status === "loading") {
        expect(screen.getByText("現在利用可能な配信はありません")).toBeTruthy();
        expect(
          screen
            .getByRole("button", { name: "Reload" })
            .hasAttribute("disabled"),
        ).toBe(true);
        expect(
          screen.getByRole("button", { name: "Load" }).hasAttribute("disabled"),
        ).toBe(true);
      } else {
        expect(
          screen.getByRole("radio", { name: "Aliceの配信を選択" }),
        ).toBeTruthy();
      }
    },
  );
});
