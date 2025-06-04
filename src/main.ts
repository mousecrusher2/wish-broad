async function load(resource: string) {
  const resourceUrl = new URL(`/play/${resource}`, location.origin);
  const pc = new RTCPeerConnection({
    // iceServers: [
    //   {
    //     urls: "stun:stun.cloudflare.com:3478",
    //   },
    // ],
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
  const remoteVideoElement = document.getElementById(
    "remote-video"
  )! as HTMLVideoElement;
  const remoteStream = new MediaStream();
  remoteStream.addTrack(remoteTracks[0]);
  remoteStream.addTrack(remoteTracks[1]);
  remoteVideoElement.srcObject = remoteStream;
}
document.querySelector("#load")!.addEventListener("click", async function () {
  const resourceInput = document.querySelector("#resource")! as HTMLInputElement;
  await load(resourceInput.value);
});
