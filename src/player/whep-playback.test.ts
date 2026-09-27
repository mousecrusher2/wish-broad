import { describe, expect, it } from "vitest";
// oxlint-disable typescript/consistent-type-assertions -- Table-driven phase fixtures intentionally narrow the playback-state type.
import {
  createDefaultPlaybackState,
  createPlaybackState,
  getPlaybackPhaseMessage,
  getPlaybackPlaceholderText,
  type WHEPPlaybackState,
} from "./whep-playback";

describe("whep-playback", () => {
  it("starts from an idle state without a selected stream", () => {
    expect(createDefaultPlaybackState()).toEqual({
      connectionStatus: "disconnected",
      hasStream: false,
      phase: "idle",
      resourceUserId: null,
      retryCount: 0,
    });
  });

  it.each(["connecting", "reconnecting"] as const)(
    "preserves the selected stream and retry count while %s",
    (phase) => {
      expect(
        createPlaybackState("streamer-1", phase, "disconnected", 3),
      ).toEqual({
        connectionStatus: "disconnected",
        hasStream: false,
        phase,
        resourceUserId: "streamer-1",
        retryCount: 3,
      });
    },
  );

  it.each([
    ["idle", null],
    ["connecting", "接続中..."],
    ["connected", null],
    ["reconnecting", "再接続中..."],
    ["ended", "配信は終了しました"],
    ["error", "接続エラーが発生しました"],
  ] as const)("maps %s to its status message", (phase, message) => {
    expect(getPlaybackPhaseMessage(phase)).toBe(message);
  });

  it.each([
    ["idle", "配信を選択して「Load」ボタンを押してください"],
    ["connecting", "接続中..."],
    ["connected", "映像を待機中..."],
    ["reconnecting", "再接続中..."],
    ["ended", "配信は終了しました"],
    ["error", "接続エラーが発生しました"],
  ] as const)("shows the %s player placeholder", (phase, placeholder) => {
    const state: WHEPPlaybackState =
      phase === "idle"
        ? {
            connectionStatus: "disconnected",
            hasStream: false,
            phase,
            resourceUserId: null,
            retryCount: 0,
          }
        : phase === "connecting"
          ? {
              connectionStatus: "connecting",
              hasStream: false,
              phase,
              resourceUserId: "streamer-1",
              retryCount: 0,
            }
          : phase === "connected"
            ? {
                connectionStatus: "connected",
                hasStream: true,
                phase,
                resourceUserId: "streamer-1",
                retryCount: 0,
              }
            : phase === "reconnecting"
              ? {
                  connectionStatus: "connecting",
                  hasStream: false,
                  phase,
                  resourceUserId: "streamer-1",
                  retryCount: 2,
                }
              : phase === "ended"
                ? {
                    connectionStatus: "disconnected",
                    hasStream: false,
                    phase,
                    resourceUserId: "streamer-1",
                    retryCount: 0,
                  }
                : {
                    connectionStatus: "failed",
                    hasStream: false,
                    phase,
                    resourceUserId: "streamer-1",
                    retryCount: 0,
                  };

    expect(getPlaybackPlaceholderText(state)).toBe(placeholder);
  });
});
