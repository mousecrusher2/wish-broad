// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WHEPPlaybackState } from "../player/whep-playback";
import { ConnectionControls } from "./ConnectionControls";

const cases: ReadonlyArray<{
  dot: string;
  message: string;
  panel: string;
  phase: WHEPPlaybackState["phase"];
  text: string;
}> = [
  {
    dot: "bg-slate-500",
    message: "\u00A0",
    panel: "border-white/10 bg-slate-900/70",
    phase: "idle",
    text: "text-slate-200",
  },
  {
    dot: "bg-emerald-400",
    message: "\u00A0",
    panel: "border-emerald-400/20 bg-emerald-500/10",
    phase: "connected",
    text: "text-emerald-100",
  },
  {
    dot: "bg-amber-400",
    message: "接続中...",
    panel: "border-amber-400/20 bg-amber-500/10",
    phase: "connecting",
    text: "text-amber-50",
  },
  {
    dot: "bg-amber-400",
    message: "再接続中...",
    panel: "border-amber-400/20 bg-amber-500/10",
    phase: "reconnecting",
    text: "text-amber-50",
  },
  {
    dot: "bg-slate-500",
    message: "配信は終了しました",
    panel: "border-white/10 bg-slate-900/70",
    phase: "ended",
    text: "text-slate-200",
  },
  {
    dot: "bg-rose-400",
    message: "接続エラーが発生しました",
    panel: "border-rose-400/20 bg-rose-500/10",
    phase: "error",
    text: "text-rose-100",
  },
];

function stateForPhase(phase: WHEPPlaybackState["phase"]): WHEPPlaybackState {
  switch (phase) {
    case "idle":
      return {
        connectionStatus: "disconnected",
        hasStream: false,
        phase,
        resourceUserId: null,
        retryCount: 0,
      };
    case "connecting":
      return {
        connectionStatus: "connecting",
        hasStream: false,
        phase,
        resourceUserId: "streamer-1",
        retryCount: 0,
      };
    case "connected":
      return {
        connectionStatus: "connected",
        hasStream: true,
        phase,
        resourceUserId: "streamer-1",
        retryCount: 0,
      };
    case "reconnecting":
      return {
        connectionStatus: "connecting",
        hasStream: false,
        phase,
        resourceUserId: "streamer-1",
        retryCount: 1,
      };
    case "ended":
      return {
        connectionStatus: "disconnected",
        hasStream: false,
        phase,
        resourceUserId: "streamer-1",
        retryCount: 0,
      };
    case "error":
      return {
        connectionStatus: "failed",
        hasStream: false,
        phase,
        resourceUserId: "streamer-1",
        retryCount: 0,
      };
  }
}

describe("ConnectionControls", () => {
  it.each(cases)("renders exact status styles and text for $phase", (item) => {
    const { container } = render(
      <ConnectionControls playbackState={stateForPhase(item.phase)} />,
    );
    const panel = container.firstElementChild;
    const [dot, label] = panel?.querySelectorAll("span") ?? [];

    expect(panel?.className).toContain(item.panel);
    expect(dot?.className).toContain(item.dot);
    expect(label?.className).toContain(item.text);
    expect(label?.textContent).toBe(item.message);
  });
});
