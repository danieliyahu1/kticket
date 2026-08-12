import { useEffect, useRef } from "react";
import QRCode from "qrcode";

export interface QrCodeProps {
  /** The compressed payload string to render (already deflate + base64url). */
  value: string;
  size?: number;
  /** Accessible label for screen readers. */
  alt?: string;
}

/**
 * Render a check-in payload as a scan-ready QR (KTK-125). The payload is the
 * compressed Option B string — the gate decodes it and re-derives the signing
 * template from chain facts.
 */
export function QrCode({ value, size = 240, alt = "Check-in QR" }: QrCodeProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    QRCode.toCanvas(canvas, value, {
      width: size,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#000000ff", light: "#ffffffff" },
    })
      .then(() => {
        if (cancelled) return;
      })
      .catch((err) => {
        console.error("[qr] render failed", err);
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  return <canvas ref={canvasRef} role="img" aria-label={alt} className="qr-canvas" />;
}
