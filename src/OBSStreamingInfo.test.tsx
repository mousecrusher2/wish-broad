// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({
  user: { status: "ready", user: { userId: "u", displayName: "Alice" } } as {
    status: string;
    user?: { userId: string; displayName: string };
    error?: string;
  },
  token: { status: "none" } as { status: string; token?: string | null },
  error: null as string | null,
  fetchTokenStatus: vi.fn<() => Promise<unknown>>(),
  createToken: vi.fn<() => Promise<unknown>>(),
  writeText: vi.fn<(value: string) => Promise<void>>(),
}));
vi.mock("./api", () => ({
  useCurrentUser: () => mock.user,
  useLiveToken: () => ({
    state: mock.token,
    error: mock.error,
    fetchTokenStatus: mock.fetchTokenStatus,
    createToken: mock.createToken,
  }),
}));
import { OBSStreamingInfo } from "./OBSStreamingInfo";

beforeEach(() => {
  mock.user = { status: "ready", user: { userId: "u", displayName: "Alice" } };
  mock.token = { status: "none" };
  mock.error = null;
  mock.fetchTokenStatus.mockReset().mockResolvedValue(ok(undefined));
  mock.createToken.mockReset().mockResolvedValue(ok(undefined));
  mock.writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: mock.writeText },
  });
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("OBS streaming settings", () => {
  it("opens the dialog, shows an ingest URL, and closes it", () => {
    const onClose = vi.fn<() => void>();
    const view = render(<OBSStreamingInfo isOpen={false} onClose={onClose} />);
    const dialog = screen.getByRole("dialog", {
      hidden: true,
    }) as HTMLDialogElement;
    expect(dialog.open).toBe(false);
    view.rerender(<OBSStreamingInfo isOpen onClose={onClose} />);
    expect(dialog.open).toBe(true);
    const url = screen.getByLabelText("配信URL (Server):") as HTMLInputElement;
    expect(url.value).toBe(`${window.location.origin}/ingest/u`);
    expect(url.readOnly).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: "OBS配信設定を閉じる" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    view.rerender(<OBSStreamingInfo isOpen={false} onClose={onClose} />);
    expect(dialog.open).toBe(false);
  });

  it("handles loading and errors for the user and token status", () => {
    mock.user = { status: "loading" };
    mock.token = { status: "loading" };
    const view = render(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    const url = screen.getByLabelText("配信URL (Server):") as HTMLInputElement;
    expect(url.value).toBe("");
    expect(url.placeholder).toBe("読み込み中...");
    expect(screen.getByRole("button", { name: "📋 コピー" })).toHaveProperty(
      "disabled",
      true,
    );
    mock.user = { status: "error", error: "not logged in" };
    mock.error = "token offline";
    view.rerender(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    expect(url.placeholder).toBe("not logged in");
    expect(screen.getByText("❌ token offline")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(mock.fetchTokenStatus).toHaveBeenCalledOnce();
  });

  it("creates, reveals, hides, and copies a new token", async () => {
    const view = render(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    expect(
      screen.getByText("⚠️ Bearerトークンが発行されていません"),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "🔑 Bearerトークンを発行" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mock.createToken).toHaveBeenCalledOnce();
    mock.token = { status: "available", token: "secret" };
    view.rerender(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    const field = screen.getByLabelText("Bearerトークン") as HTMLInputElement;
    expect(field.value).toBe("secret");
    expect(field.readOnly).toBe(true);
    const copyButton = screen.getAllByRole("button", { name: "📋 コピー" })[1];
    if (!copyButton) throw new Error("Expected the token copy button");
    fireEvent.click(copyButton);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mock.writeText).toHaveBeenCalledWith("secret");
    expect(screen.getByText("✅ コピー済み")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "🙈 非表示" }));
    expect(screen.queryByLabelText("Bearerトークン")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "👁️ トークンを表示" }));
    expect(screen.getByLabelText("Bearerトークン")).toBeTruthy();
  });

  it("explains that an existing token cannot be retrieved, and allows regeneration", async () => {
    mock.token = { status: "available", token: null };
    render(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    expect(screen.getByText(/既存のトークンは再表示できません/u)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "👁️ トークンを表示" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "🔄 新しいトークンを発行" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(mock.createToken).toHaveBeenCalledOnce();
  });

  it("copies the authenticated URL and reports clipboard rejection", async () => {
    vi.stubGlobal("alert", vi.fn());
    render(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "📋 コピー" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(mock.writeText).toHaveBeenCalledWith(
      `${window.location.origin}/ingest/u`,
    );
    mock.writeText.mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "✅ コピー済み" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(console.error).toHaveBeenCalledWith(
      "Failed to copy to clipboard:",
      expect.any(Error),
    );
    expect(alert).toHaveBeenCalledWith(
      "クリップボードへのコピーに失敗しました",
    );
    vi.unstubAllGlobals();
  });

  it("does not reveal a token when creation fails", async () => {
    mock.createToken.mockResolvedValue(err(new Error("offline")));
    const view = render(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "🔑 Bearerトークンを発行" }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    mock.token = { status: "available", token: "secret" };
    view.rerender(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "👁️ トークンを表示" }),
    ).toBeTruthy();
  });

  it("shows the default user placeholder and OBS setup steps", () => {
    mock.user = { status: "unauthenticated" };
    render(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    const url = screen.getByLabelText("配信URL (Server):") as HTMLInputElement;
    expect(url.placeholder).toBe("取得できません");
    expect(url.value).toBe("");
    expect(screen.getByText("📖 OBS設定方法")).toBeTruthy();
    expect(screen.getByText("サービス: 「WHIP」を選択")).toBeTruthy();
    expect(
      screen.getByText("Bearerトークン: 上記の配信キーをコピー"),
    ).toBeTruthy();
  });

  it("resets the copy success indicator after two seconds", async () => {
    vi.useFakeTimers();
    try {
      render(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "📋 コピー" }));
      await act(async () => {
        await Promise.resolve();
      });
      expect(
        screen.getByRole("button", { name: "✅ コピー済み" }),
      ).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1_999);
      });
      expect(
        screen.getByRole("button", { name: "✅ コピー済み" }),
      ).toBeTruthy();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(screen.getByRole("button", { name: "📋 コピー" })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("hides a revealed token before retrying status lookup", async () => {
    mock.token = { status: "available", token: "secret" };
    const view = render(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "👁️ トークンを表示" }));
    expect(screen.getByLabelText("Bearerトークン")).toBeTruthy();
    mock.token = { status: "error" };
    mock.error = "offline";
    view.rerender(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(mock.fetchTokenStatus).toHaveBeenCalledOnce();
    mock.token = { status: "available", token: "secret" };
    mock.error = null;
    view.rerender(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    expect(screen.queryByLabelText("Bearerトークン")).toBeNull();
  });

  it("applies recognizable styling to fields and actions", () => {
    const view = render(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    const url = screen.getByLabelText("配信URL (Server):");
    const label = screen.getByText("配信URL (Server):");
    const copy = screen.getByRole("button", { name: "📋 コピー" });
    const create = screen.getByRole("button", {
      name: "🔑 Bearerトークンを発行",
    });
    expect(label.className).toContain("text-slate-200");
    expect(url.className).toContain("focus:border-cyan-400");
    expect(url.parentElement?.className).toContain("sm:flex-row");
    expect(copy.className).toContain("hover:bg-slate-700");
    expect(create.className).toContain("bg-cyan-400");
    expect(
      screen.getByText("📖 OBS設定方法").parentElement?.className,
    ).toContain("bg-slate-950/30");
    expect(
      screen.getByText("Bearerトークン (Stream Key):").parentElement?.className,
    ).toContain("shadow-inner");
    mock.token = { status: "available", token: "secret" };
    view.rerender(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    expect(
      screen.getByRole("button", { name: "👁️ トークンを表示" }).className,
    ).toContain("border-slate-600");
    expect(
      screen.getByRole("button", { name: "🔄 新しいトークンを発行" }).className,
    ).toContain("bg-amber-400");
    fireEvent.click(screen.getByRole("button", { name: "👁️ トークンを表示" }));
    expect(screen.getByLabelText("Bearerトークン").className).toContain(
      "focus:ring-cyan-400/20",
    );
    expect(
      screen.getByRole("button", { name: "🙈 非表示" }).className,
    ).toContain("border-slate-600");
    mock.error = "offline";
    view.rerender(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "再試行" }).className).toContain(
      "bg-rose-500",
    );
  });

  it("shows a loading token indicator without an error", () => {
    mock.token = { status: "loading" };
    render(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    expect(screen.getByText("読み込み中...")).toHaveProperty("tagName", "P");
    expect(screen.getByText("読み込み中...").className).toContain(
      "text-amber-200",
    );
  });
});
