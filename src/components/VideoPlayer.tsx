import { forwardRef } from "react";

interface VideoPlayerProps {
  streamUrl: string | null;
}

export const VideoPlayer = forwardRef<HTMLVideoElement, VideoPlayerProps>(
  ({ streamUrl }, ref) => {
    return (
      <div className="remote-media-section">
        <h2>配信映像</h2>
        <div className="video-player-container">
          {streamUrl ? (
            <video
              ref={ref}
              className="styled-video-player"
              controls
              autoPlay
              muted
              playsInline
            />
          ) : (
            <div className="no-stream-placeholder">
              配信を選択して「Load」ボタンを押してください
            </div>
          )}
        </div>
      </div>
    );
  }
);
