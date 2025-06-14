import { useState, useRef } from "react";
import type { WHEPPlayerProps } from "./types";
import { useLiveStreams } from "./useLiveStreams";

export function WHEPPlayer({ user }: WHEPPlayerProps) {
  console.log(user);
  const [resource, setResource] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { streams, isLoading: streamsLoading, error: streamsError, refresh } = useLiveStreams();

  const load = async (resourceValue: string) => {
    if (!resourceValue) return;

    setIsLoading(true);

    try {
      const resourceUrl = new URL(`/play/${resourceValue}`, location.origin);
      const pc = new RTCPeerConnection({
        bundlePolicy: "max-bundle",
      });

      const candidatesPromise = new Promise<void>((resolve) => {
        pc.addEventListener("icegatheringstatechange", (ev) => {
          let connection = ev.target as RTCPeerConnection;
          if (!connection) {
            throw new Error("No connection found");
          }

          switch (connection.iceGatheringState) {
            case "complete":
              resolve();
              break;
          }
        });
      });

      const remoteTracksPromise = new Promise<MediaStreamTrack[]>((resolve) => {
        let tracks: MediaStreamTrack[] = [];
        pc.ontrack = (event) => {
          tracks.push(event.track);
          console.debug(event);
          if (tracks.length >= 2) {
            // remote video & audio are ready
            resolve(tracks);
          }
        };
      });

      const offer = await fetch(resourceUrl, { method: "POST" });
      await pc.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp: await offer.text() })
      );
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await candidatesPromise;
      let sessionUrl = new URL(resourceUrl);
      sessionUrl.pathname = offer.headers.get("location")!;
      await fetch(sessionUrl.href, { method: "PATCH", body: answer.sdp });
      const remoteTracks = await remoteTracksPromise;

      if (videoRef.current) {
        const remoteStream = new MediaStream();
        remoteStream.addTrack(remoteTracks[0]);
        remoteStream.addTrack(remoteTracks[1]);
        videoRef.current.srcObject = remoteStream;
      }
    } catch (error) {
      console.error("Failed to load stream:", error);
      alert("ストリームの読み込みに失敗しました");
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadClick = async () => {
    await load(resource);
  };
  return (
    <div className="grid">
      <h1>Basic WISH WHEP Player</h1>
      <div className="user-info">
        <p>ようこそ、{user.displayName}さん</p>
      </div>
      <div className="stream-selection">
        <label htmlFor="stream-select">配信を選択:</label>
        {streamsLoading ? (
          <p>配信リストを読み込み中...</p>
        ) : streamsError ? (
          <div>
            <p>エラー: {streamsError}</p>
            <button onClick={refresh} type="button">
              再試行
            </button>
          </div>        ) : (
          <select
            id="stream-select"
            value={resource}
            onChange={(e) => setResource(e.target.value)}
            disabled={isLoading}
          >
            <option value="">配信を選択してください</option>
            {streams.map((stream, index) => (
              <option key={index} value={stream.owner.userId}>
                {stream.owner.displayName}の配信 ({stream.owner.userId})
              </option>
            ))}
          </select>
        )}
      </div>
      <div>
        <button
          onClick={handleLoadClick}
          disabled={isLoading || !resource.trim() || streamsLoading}
        >
          {isLoading ? "読み込み中..." : "Load"}
        </button>
      </div>
      <div>
        <h2>Remote media</h2>
        <video ref={videoRef} autoPlay />
      </div>
    </div>
  );
}
