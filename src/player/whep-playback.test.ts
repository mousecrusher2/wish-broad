import { describe, expect, it } from "vitest";
import {
  createDefaultPlaybackState,
  createPlaybackState,
  getPlaybackPhaseMessage,
  getPlaybackPlaceholderText,
} from "./whep-playback";

describe("playback view state", () => {
  it("starts idle and retains the resource, phase, status, and retry count", () => {
    expect(createDefaultPlaybackState()).toEqual({
      connectionStatus: "disconnected",
      hasStream: false,
      phase: "idle",
      resourceUserId: null,
      retryCount: 0,
    });
    expect(createPlaybackState("user", "connecting", "failed", 2)).toEqual({
      connectionStatus: "failed",
      hasStream: false,
      phase: "connecting",
      resourceUserId: "user",
      retryCount: 2,
    });
    expect(
      createPlaybackState("other", "reconnecting", "disconnected", 3),
    ).toEqual({
      connectionStatus: "disconnected",
      hasStream: false,
      phase: "reconnecting",
      resourceUserId: "other",
      retryCount: 3,
    });
  });

  it.each([
    ["idle", null, "配信を選択して「Load」ボタンを押してください"],
    ["connected", null, "映像を待機中..."],
    ["connecting", "接続中...", "接続中..."],
    ["reconnecting", "再接続中...", "再接続中..."],
    ["ended", "配信は終了しました", "配信は終了しました"],
    ["error", "接続エラーが発生しました", "接続エラーが発生しました"],
  ] as const)("renders the %s phase", (phase, statusMessage, placeholder) => {
    expect(getPlaybackPhaseMessage(phase)).toBe(statusMessage);
    const state = { ...createDefaultPlaybackState(), phase };
    // Every phase uses the same display text independently of its protocol fields.
    expect(
      getPlaybackPlaceholderText(
        state as Parameters<typeof getPlaybackPlaceholderText>[0],
      ),
    ).toBe(placeholder);
  });
});
