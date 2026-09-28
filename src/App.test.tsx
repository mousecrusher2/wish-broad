// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const appMocks = vi.hoisted<{ authState: unknown }>(() => ({
  authState: { status: "loading" },
}));
vi.mock("./api", () => ({ useBootstrapAuthState: () => appMocks.authState }));
vi.mock("./WHEPPlayerPage", () => ({
  WHEPPlayerPage: () => <main data-testid="player-page">Viewer dashboard</main>,
}));

import App from "./App";

describe("application auth bootstrap", () => {
  beforeEach(() => {
    appMocks.authState = { status: "loading" };
  });

  afterEach(cleanup);

  it("shows a loading screen while authentication is unresolved", () => {
    const { container } = render(<App />);

    const heading = screen.getByRole("heading", {
      name: "ANGOU BROADCAST",
    });
    const status = screen.getByText("認証状態を確認中...");
    expect(heading).toBeTruthy();
    expect(status).toBeTruthy();
    expect(container.firstElementChild?.className).toContain("min-h-screen");
    expect(heading.parentElement?.className).toContain("rounded-4xl");
    expect(heading.className).toContain("tracking-tight");
    expect(status.className).toContain("leading-7");
    expect(
      screen.queryByRole("link", { name: "Discordでログイン" }),
    ).toBeNull();
  });

  it("renders the player page when authenticated", () => {
    appMocks.authState = { status: "authenticated" };
    render(<App />);

    expect(screen.getByTestId("player-page").textContent).toBe(
      "Viewer dashboard",
    );
    expect(
      screen.queryByRole("link", { name: "Discordでログイン" }),
    ).toBeNull();
  });

  it("offers a Discord login when unauthenticated", () => {
    appMocks.authState = { status: "unauthenticated" };
    render(<App />);

    expect(
      screen
        .getByRole("link", { name: "Discordでログイン" })
        .getAttribute("href"),
    ).toBe("/login");
    expect(
      screen.getByText(
        "このアプリケーションを使用するにはログインが必要です。",
      ),
    ).toBeTruthy();
  });

  it("shows auth errors and invokes the browser reload action", () => {
    appMocks.authState = { status: "error", error: "worker unavailable" };
    const reload = vi.fn<() => void>();
    vi.stubGlobal(
      "window",
      new Proxy(window, {
        get(target, property) {
          if (property === "location") return { reload };
          const value: unknown = Reflect.get(target, property, target);
          return value;
        },
      }),
    );
    const { container } = render(<App />);

    expect(
      screen.getByText("認証状態の確認中にエラーが発生しました。"),
    ).toBeTruthy();
    expect(screen.getByText("worker unavailable")).toBeTruthy();
    expect(container.firstElementChild?.className).toContain("min-h-screen");
    const reloadButton = screen.getByRole("button", { name: "再読み込み" });
    expect(reloadButton.className).toContain("bg-cyan-400");
    fireEvent.click(reloadButton);
    expect(reload).toHaveBeenCalledOnce();
  });
});
