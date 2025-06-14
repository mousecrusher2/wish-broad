import { useState, useRef } from 'react'

function App() {
  const [resource, setResource] = useState('')
  const videoRef = useRef<HTMLVideoElement>(null)

  const load = async (resourceValue: string) => {
    if (!resourceValue) return

    const resourceUrl = new URL(`/play/${resourceValue}`, location.origin)
    const pc = new RTCPeerConnection({
      bundlePolicy: "max-bundle",
    })

    const candidatesPromise = new Promise<void>((resolve) => {
      pc.addEventListener("icegatheringstatechange", (ev) => {
        let connection = ev.target as RTCPeerConnection
        if (!connection) {
          throw new Error("No connection found")
        }

        switch (connection.iceGatheringState) {
          case "complete":
            resolve()
            break
        }
      })
    })

    const remoteTracksPromise = new Promise<MediaStreamTrack[]>((resolve) => {
      let tracks: MediaStreamTrack[] = []
      pc.ontrack = (event) => {
        tracks.push(event.track)
        console.debug(event)
        if (tracks.length >= 2) {
          // remote video & audio are ready
          resolve(tracks)
        }
      }
    })

    const offer = await fetch(resourceUrl, { method: "POST" })
    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp: await offer.text() })
    )
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await candidatesPromise
    let sessionUrl = new URL(resourceUrl)
    sessionUrl.pathname = offer.headers.get("location")!
    await fetch(sessionUrl.href, { method: "PATCH", body: answer.sdp })
    const remoteTracks = await remoteTracksPromise

    if (videoRef.current) {
      const remoteStream = new MediaStream()
      remoteStream.addTrack(remoteTracks[0])
      remoteStream.addTrack(remoteTracks[1])
      videoRef.current.srcObject = remoteStream
    }
  }

  const handleLoadClick = async () => {
    await load(resource)
  }

  return (
    <div className="grid">
      <h1>Basic WISH WHEP 00 Player</h1>
      <div>
        <input
          type="text"
          value={resource}
          onChange={(e) => setResource(e.target.value)}
          placeholder="Enter resource"
        />
      </div>
      <div>
        <button onClick={handleLoadClick}>Load</button>
      </div>
      <div>
        <h2>Remote media</h2>
        <video ref={videoRef} autoPlay />
      </div>
    </div>
  )
}

export default App
