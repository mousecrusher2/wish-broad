// @vitest-environment jsdom
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("client entry point", () => {
  afterEach(() => {
    cleanup();
    vi.doUnmock("./App");
    vi.doUnmock("./style.css");
    vi.resetModules();
  });

  it("fails fast when the root mount element is missing", async () => {
    document.body.innerHTML = "";
    vi.doMock("./style.css", () => ({}));

    await expect(import("./main")).rejects.toThrow("Root element not found");
  });

  it("mounts the application into the root element", async () => {
    document.body.innerHTML = '<div id="root"></div>';
    vi.doMock("./style.css", () => ({}));
    vi.doMock("./App", () => ({ default: () => <p>Mounted app</p> }));

    await import("./main");
    await waitFor(() => {
      expect(screen.getByText("Mounted app")).toBeTruthy();
    });
  });
});
