// Gate camera scan loop (KTK-130) — the organizer's device at the door.
//
// Runs getUserMedia in a loop, draws each video frame to a canvas, and decodes
// QRs with jsQR. The hook owns the camera lifecycle (start / stop / permission
// denial) and hands every decoded payload string to `onDecode`; the gate state
// machine owns what happens after.

import { useCallback, useEffect, useRef, useState } from "react";
import jsQR from "jsqr";

export type CameraStatus =
  | { phase: "starting" }
  | { phase: "scanning" }
  | { phase: "denied" }
  | { phase: "error"; message: string };

export interface UseCameraOptions {
  /** Whether the camera should run (e.g. false while a dialog is open). */
  enabled: boolean;
  /** Invoked with the decoded payload string; throw to keep scanning. */
  onDecode: (payload: string) => Promise<void> | void;
}

export interface UseCameraResult {
  status: CameraStatus;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
}

const FRAME_RATE_MS = 250;

export function useCamera({ enabled, onDecode }: UseCameraOptions): UseCameraResult {
  const [status, setStatus] = useState<CameraStatus>({ phase: "starting" });
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onDecodeRef = useRef(onDecode);
  onDecodeRef.current = onDecode;

  const stop = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
  }, []);

  useEffect(() => {
    if (!enabled) {
      stop();
      return;
    }

    let cancelled = false;
    let raf = 0;

    async function start() {
      setStatus({ phase: "starting" });
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        streamRef.current = stream;
        setStatus({ phase: "scanning" });
      } catch (err) {
        if (cancelled) return;
        setStatus(isPermissionError(err) ? { phase: "denied" } : { phase: "error", message: String(err) });
        return;
      }

      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      video.srcObject = streamRef.current;
      await video.play().catch(() => {});

      function tick() {
        if (cancelled) return;
        raf = requestAnimationFrame(tick);
        const videoEl = videoRef.current;
        const canvasEl = canvasRef.current;
        const ctx = canvasEl?.getContext("2d", { willReadFrequently: true });
        if (!videoEl || !canvasEl || !ctx) return;
        if (videoEl.readyState < 2 || videoEl.videoWidth === 0) return;
        canvasEl.width = videoEl.videoWidth;
        canvasEl.height = videoEl.videoHeight;
        ctx.drawImage(videoEl, 0, 0, canvasEl.width, canvasEl.height);
        const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
        const code = jsQR(imageData.data, imageData.width, imageData.height);
        if (code?.data) {
          void onDecodeRef.current(code.data);
        }
      }

      setTimeout(tick, FRAME_RATE_MS);
    }

    void start();

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      stop();
    };
  }, [enabled, stop]);

  return { status, videoRef, canvasRef };
}

function isPermissionError(err: unknown): boolean {
  const name = (err as { name?: string } | null)?.name ?? "";
  return name === "NotAllowedError" || name === "PermissionDeniedError";
}
