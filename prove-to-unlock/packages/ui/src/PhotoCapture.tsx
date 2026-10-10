import { useEffect, useRef, useState } from "preact/hooks";

export interface CapturedPhoto {
  canvas: HTMLCanvasElement;
  imageData: ImageData;
  capturedAt: number;
}

/**
 * Live camera capture only: there is deliberately no file picker, so old photos can't be used.
 */
export function PhotoCapture(props: { challenge?: string; onCapture: (p: CapturedPhoto) => void; onCancel?: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        if (video.current) {
          video.current.srcObject = s;
          void video.current.play();
          setReady(true);
        }
      })
      .catch((e: Error) => setError(e.name === "NotAllowedError" ? "Camera permission was denied." : `No camera available (${e.message}).`));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const capture = () => {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(v, 0, 0);
    props.onCapture({ canvas: c, imageData: ctx.getImageData(0, 0, c.width, c.height), capturedAt: Date.now() });
  };

  return (
    <div class="ptu-camera">
      {props.challenge && <div class="ptu-challenge">Challenge: {props.challenge}</div>}
      {error ? <div class="ptu-fail">{error}</div> : <video ref={video} playsInline muted />}
      <div class="ptu-row">
        <button class="ptu-btn primary" disabled={!ready} onClick={capture}>
          Take photo
        </button>
        {props.onCancel && (
          <button class="ptu-btn" onClick={props.onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
