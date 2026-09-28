// @vitest-environment jsdom
// oxlint-disable typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion, typescript/strict-void-return, typescript/unbound-method, vitest/require-mock-type-parameters -- Native dialog and clipboard APIs need browser-shaped test doubles in jsdom.
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { err, ok } from "neverthrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const obsMocks = vi.hoisted(() => ({
  createToken: vi.fn(),
  currentUserState: { status: "loading" } as unknown,
  fetchTokenStatus: vi.fn(),
  tokenError: null as string | null,
  tokenState: { status: "loading" } as unknown,
}));

vi.mock("./api", () => ({
  useCurrentUser: () => obsMocks.currentUserState,
  useLiveToken: () => ({
    createToken: obsMocks.createToken,
    error: obsMocks.tokenError,
    fetchTokenStatus: obsMocks.fetchTokenStatus,
    state: obsMocks.tokenState,
  }),
}));

import { OBSStreamingInfo } from "./OBSStreamingInfo";

function renderOpen(onClose = vi.fn<() => void>()) {
  return render(<OBSStreamingInfo isOpen onClose={onClose} />);
}

let originalShowModal: PropertyDescriptor | undefined;
let originalClose: PropertyDescriptor | undefined;
let showModalSpy: ReturnType<typeof vi.fn<(this: HTMLDialogElement) => void>>;
let closeSpy: ReturnType<typeof vi.fn<(this: HTMLDialogElement) => void>>;

describe("OBSStreamingInfo setup dialog", () => {
  beforeEach(() => {
    obsMocks.currentUserState = { status: "loading" };
    obsMocks.tokenError = null;
    obsMocks.tokenState = { status: "loading" };
    obsMocks.createToken.mockReset().mockResolvedValue(ok(undefined));
    obsMocks.fetchTokenStatus.mockReset().mockResolvedValue(ok(undefined));
    originalShowModal = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      "showModal",
    );
    originalClose = Object.getOwnPropertyDescriptor(
      HTMLDialogElement.prototype,
      "close",
    );
    showModalSpy = vi.fn<(this: HTMLDialogElement) => void>(function () {
      this.setAttribute("open", "");
    });
    closeSpy = vi.fn<(this: HTMLDialogElement) => void>(function () {
      this.removeAttribute("open");
    });
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
      configurable: true,
      value: showModalSpy,
    });
    Object.defineProperty(HTMLDialogElement.prototype, "close", {
      configurable: true,
      value: closeSpy,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalShowModal) {
      Object.defineProperty(
        HTMLDialogElement.prototype,
        "showModal",
        originalShowModal,
      );
    } else {
      Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
    }
    if (originalClose) {
      Object.defineProperty(
        HTMLDialogElement.prototype,
        "close",
        originalClose,
      );
    } else {
      Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
    }
  });

  it("opens and closes the native dialog in response to its prop", () => {
    const onClose = vi.fn<() => void>();
    const { rerender } = render(
      <OBSStreamingInfo isOpen={false} onClose={onClose} />,
    );
    const dialog = document.querySelector("dialog");
    expect(dialog?.hasAttribute("open")).toBe(false);

    rerender(<OBSStreamingInfo isOpen onClose={onClose} />);
    expect(showModalSpy).toHaveBeenCalledOnce();
    expect(dialog?.hasAttribute("open")).toBe(true);

    fireEvent.click(
      screen.getByRole("button", { name: "OBS配信設定を閉じる" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<OBSStreamingInfo isOpen={false} onClose={onClose} />);
    expect(closeSpy).toHaveBeenCalledOnce();
    expect(dialog?.hasAttribute("open")).toBe(false);
  });

  it("renders loading, ready, and failed streaming URL states", () => {
    const { rerender } = renderOpen();
    const url = screen.getByLabelText("配信URL (Server):") as HTMLInputElement;
    expect(url.placeholder).toBe("読み込み中...");
    expect(url.value).toBe("");
    expect(url.readOnly).toBe(true);
    expect(url.className).toContain("shadow-inner");
    expect(url.parentElement?.className).toContain("sm:flex-row");
    expect(screen.getByText("配信URL (Server):").className).toContain(
      "tracking-wide",
    );
    expect(
      screen.getByRole("button", { name: "📋 コピー" }).className,
    ).toContain("rounded-full");
    expect(
      screen
        .getByRole("button", { name: "📋 コピー" })
        .hasAttribute("disabled"),
    ).toBe(true);

    obsMocks.currentUserState = { status: "error", error: "user unavailable" };
    rerender(<OBSStreamingInfo isOpen onClose={vi.fn<() => void>()} />);
    expect(url.placeholder).toBe("user unavailable");

    obsMocks.currentUserState = {
      status: "ready",
      user: { displayName: "Alice", userId: "user-1" },
    };
    rerender(<OBSStreamingInfo isOpen onClose={vi.fn<() => void>()} />);
    expect(url.value).toBe(`${window.location.origin}/ingest/user-1`);
    expect(url.placeholder).toBe("取得できません");
    expect(
      screen
        .getByRole("button", { name: "📋 コピー" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("shows empty and available token states, and toggles a one-time token", async () => {
    obsMocks.currentUserState = {
      status: "ready",
      user: { displayName: "Alice", userId: "user-1" },
    };
    obsMocks.tokenState = { status: "none" };
    const { rerender } = renderOpen();
    expect(
      screen.getByRole("button", { name: "🔑 Bearerトークンを発行" }).className,
    ).toContain("bg-cyan-400");
    expect(
      screen.getByText("⚠️ Bearerトークンが発行されていません"),
    ).toBeTruthy();

    obsMocks.tokenState = { status: "available", token: null };
    rerender(<OBSStreamingInfo isOpen onClose={vi.fn<() => void>()} />);
    expect(screen.getByText(/既存のトークンは再表示できません/u)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "👁️ トークンを表示" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Bearerトークン")).toBeNull();

    obsMocks.tokenState = { status: "available", token: "new-secret" };
    obsMocks.createToken.mockImplementation(async () => {
      obsMocks.tokenState = { status: "available", token: "new-secret" };
      return ok(undefined);
    });
    rerender(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "🔄 新しいトークンを発行" }),
    );
    expect(
      screen.getByRole("button", { name: "🔄 新しいトークンを発行" }).className,
    ).toContain("bg-amber-400");
    await screen.findByLabelText("Bearerトークン");
    expect(
      screen.getByLabelText<HTMLInputElement>("Bearerトークン").value,
    ).toBe("new-secret");

    fireEvent.click(screen.getByRole("button", { name: "🙈 非表示" }));
    expect(screen.queryByLabelText("Bearerトークン")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "👁️ トークンを表示" }));
    expect(
      screen.getByRole("button", { name: "🙈 非表示" }).className,
    ).toContain("border-slate-600");
    expect(screen.getByLabelText("Bearerトークン")).toBeTruthy();
    expect(screen.getByText("📖 OBS設定方法")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("renders token loading independently from the streaming URL", () => {
    obsMocks.currentUserState = {
      status: "ready",
      user: { displayName: "Alice", userId: "user-1" },
    };
    obsMocks.tokenState = { status: "loading" };
    renderOpen();

    expect(screen.getByText("読み込み中...")).toBeTruthy();
    expect(
      screen.getByLabelText<HTMLInputElement>("配信URL (Server):").value,
    ).toBe(`${window.location.origin}/ingest/user-1`);
    expect(
      screen
        .getByRole("button", { name: "📋 コピー" })
        .hasAttribute("disabled"),
    ).toBe(false);
  });

  it("retries token status and hides a token after a failed revalidation", () => {
    obsMocks.tokenState = { status: "available", token: "secret" };
    const { rerender } = renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "👁️ トークンを表示" }));
    expect(screen.getByLabelText("Bearerトークン")).toBeTruthy();

    obsMocks.tokenError = "status unavailable";
    rerender(<OBSStreamingInfo isOpen onClose={vi.fn()} />);

    expect(screen.getByText("❌ status unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "再試行" }).className).toContain(
      "bg-rose-500",
    );
    fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    expect(obsMocks.fetchTokenStatus).toHaveBeenCalledOnce();

    obsMocks.tokenError = null;
    rerender(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    expect(screen.queryByLabelText("Bearerトークン")).toBeNull();
    expect(
      screen.getByRole("button", { name: "👁️ トークンを表示" }),
    ).toBeTruthy();
  });

  it("copies URLs and tokens, then resets the copy status", async () => {
    vi.useFakeTimers();
    obsMocks.currentUserState = {
      status: "ready",
      user: { displayName: "Alice", userId: "user-1" },
    };
    obsMocks.tokenState = { status: "available", token: "secret" };
    const clipboardWriteText = vi
      .fn<(text: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    const { rerender } = renderOpen();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "📋 コピー" }));
    });
    expect(clipboardWriteText).toHaveBeenCalledWith(
      `${window.location.origin}/ingest/user-1`,
    );
    expect(screen.getByRole("button", { name: "✅ コピー済み" })).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(2_000);
    });
    expect(screen.getByRole("button", { name: "📋 コピー" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "👁️ トークンを表示" }));
    rerender(<OBSStreamingInfo isOpen onClose={vi.fn()} />);
    await act(async () => {
      const copyButtons = screen.getAllByRole("button", { name: "📋 コピー" });
      const tokenCopyButton = copyButtons.at(-1);
      if (!tokenCopyButton) throw new Error("Expected a token copy button");
      fireEvent.click(tokenCopyButton);
    });
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith("secret");
    expect(screen.getByRole("button", { name: "✅ コピー済み" })).toBeTruthy();
  });

  it("alerts and logs when clipboard writes fail", async () => {
    const error = new Error("clipboard denied");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const alert = vi.spyOn(window, "alert").mockImplementation(() => undefined);
    obsMocks.currentUserState = {
      status: "ready",
      user: { displayName: "Alice", userId: "user-1" },
    };
    const clipboardWriteText = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValue(error);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    renderOpen();

    fireEvent.click(screen.getByRole("button", { name: "📋 コピー" }));
    await vi.waitFor(() => {
      expect(alert).toHaveBeenCalledWith(
        "クリップボードへのコピーに失敗しました",
      );
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Failed to copy to clipboard:",
      error,
    );
  });

  it("does not expose a token when creation fails", async () => {
    obsMocks.tokenState = { status: "available", token: "existing-secret" };
    obsMocks.createToken.mockResolvedValue(err(new Error("create failed")));
    renderOpen();

    fireEvent.click(
      screen.getByRole("button", { name: "🔄 新しいトークンを発行" }),
    );
    await vi.waitFor(() => {
      expect(obsMocks.createToken).toHaveBeenCalledOnce();
    });
    expect(screen.queryByLabelText("Bearerトークン")).toBeNull();
  });
});
