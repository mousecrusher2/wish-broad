// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionControls } from "./components/ConnectionControls";
import { StreamSelection } from "./components/StreamSelection";
import { LoginPrompt } from "./LoginPrompt";
import {
  createDefaultPlaybackState,
  createPlaybackState,
  type WHEPPlaybackState,
} from "./player/whep-playback";

const auth = vi.hoisted(() => ({
  state: { status: "loading" } as { status: string; error?: string },
}));
vi.mock("./api", () => ({ useBootstrapAuthState: () => auth.state }));
vi.mock("./WHEPPlayerPage", () => ({
  WHEPPlayerPage: () => <div>Player page</div>,
}));
import App from "./App";

afterEach(() => cleanup());

describe("authentication screens", () => {
  it.each([
    ["loading", "認証状態を確認中..."],
    ["authenticated", "Player page"],
    ["unauthenticated", "Discordでログイン"],
    ["error", "認証状態の確認中にエラーが発生しました。"],
  ])("renders the %s bootstrap state", (status, expected) => {
    auth.state = { status, error: "offline" };
    render(<App />);
    expect(screen.getByText(expected)).toBeTruthy();
    if (status === "error") expect(screen.getByText("offline")).toBeTruthy();
  });

  it("links the login prompt to the Discord login endpoint", () => {
    render(<LoginPrompt />);
    expect(
      screen
        .getByRole("link", { name: "Discordでログイン" })
        .getAttribute("href"),
    ).toBe("/login");
  });
});

describe("stream browser", () => {
  it.each([
    [createDefaultPlaybackState(), ""],
    [createPlaybackState("user", "connecting", "connecting", 0), "接続中..."],
    [
      createPlaybackState("user", "reconnecting", "disconnected", 2),
      "再接続中...",
    ],
    [
      {
        connectionStatus: "disconnected",
        hasStream: false,
        phase: "ended",
        resourceUserId: "user",
        retryCount: 0,
      } satisfies WHEPPlaybackState,
      "配信は終了しました",
    ],
    [
      {
        connectionStatus: "failed",
        hasStream: false,
        phase: "error",
        resourceUserId: "user",
        retryCount: 0,
      } satisfies WHEPPlaybackState,
      "接続エラーが発生しました",
    ],
  ] as const)("shows the %s connection phase", (state, text) => {
    const { container } = render(<ConnectionControls playbackState={state} />);
    expect(container.textContent?.trim()).toBe(text);
    expect(container.querySelector(".rounded-full")).toBeTruthy();
  });

  function showBrowser(
    overrides: Partial<Parameters<typeof StreamSelection>[0]> = {},
  ) {
    const onRefresh = vi.fn<() => void>();
    const onResourceChange = vi.fn<(resource: string) => void>();
    const onLoadClick = vi.fn<() => void>();
    const props = {
      resource: "",
      onResourceChange,
      streams: [
        { owner: { userId: "u1", displayName: "Alice" } },
        { owner: { userId: "u2", displayName: "Bob" } },
      ],
      isLoading: false,
      error: null,
      onRefresh,
      onLoadClick,
      streamsLoading: false,
      playbackState: createDefaultPlaybackState(),
      ...overrides,
    };
    render(<StreamSelection {...props} />);
    return { onRefresh, onResourceChange, onLoadClick };
  }

  it("selects a live stream and invokes refresh and load actions", () => {
    const actions = showBrowser({ resource: "u1" });
    expect(screen.getAllByText("Alice")).toHaveLength(2);
    expect(screen.getByText(/選択中:/u).textContent).toContain("Alice");
    expect(
      (
        screen.getByRole("radio", {
          name: "Bobの配信を選択",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
    expect(
      (
        screen.getByRole("radio", {
          name: "Aliceの配信を選択",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Bobの配信を選択" }));
    expect(actions.onResourceChange).toHaveBeenCalledWith("u2");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(actions.onRefresh).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Load" }));
    expect(actions.onLoadClick).toHaveBeenCalledOnce();
  });

  it("explains empty streams, missing selection, and supports retry", () => {
    const actions = showBrowser({
      streams: [],
      resource: "missing",
      error: "offline",
    });
    expect(screen.getByText("現在利用可能な配信はありません")).toBeTruthy();
    expect(screen.getByText("不明な配信")).toBeTruthy();
    expect(screen.getByText("エラー: offline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(actions.onRefresh).toHaveBeenCalledOnce();
  });

  it.each([
    [{ resource: "" }, "Load"],
    [{ resource: "   " }, "Load"],
    [{ resource: "u1", isLoading: true }, "読み込み中..."],
    [{ resource: "u1", streamsLoading: true }, "Load"],
  ] as const)("disables loading for %s", (props, buttonText) => {
    showBrowser(props);
    expect(
      (screen.getByRole("button", { name: buttonText }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it("prevents refresh during stream loading", () => {
    showBrowser({ streamsLoading: true });
    expect(
      (screen.getByRole("button", { name: "Reload" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
