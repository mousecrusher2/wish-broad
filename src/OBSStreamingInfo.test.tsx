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
});
