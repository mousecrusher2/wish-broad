export type NewSessionResponse = {
  sessionId: string;
};

export type NewTrackResponse = {
  trackName: string;
  mid: string;
};

export type NewTracksResponse = {
  tracks: NewTrackResponse[];
  sessionDescription: SessionDescription;
};

export type SessionDescription = {
  sdp: string;
  type: string;
};

export type TrackLocator = {
  location: string;
  sessionId: string;
  trackName: string;
};
