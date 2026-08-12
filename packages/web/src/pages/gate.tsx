import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchEvent, ServerError, type EventDetail } from "../api/client";
import {
  decodeError,
  decodeGatePayload,
  isDecodeFailure,
  prepareGateCheck,
  type GateParams,
  type GateState,
  errorMsg,
  logError,
  logStep,
} from "../api/gate-machine";
import { Empty, OfflineEmpty } from "../components/empty";
import { useCamera } from "../hooks/use-camera";

export default function GatePage() {
  const { covenantId } = useParams<{ covenantId: string }>();
  const [event, setEvent] = useState<EventDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [gate, setGate] = useState<GateState>({ phase: "scanning" });

  const load = useCallback(async () => {
    if (!covenantId) return;
    setLoading(true);
    setOffline(false);
    try {
      const e = await fetchEvent(covenantId);
      setEvent(e);
    } catch (err) {
      if (err instanceof ServerError) {
        setOffline(true);
      } else {
        setEvent(null);
      }
    } finally {
      setLoading(false);
    }
  }, [covenantId]);

  useEffect(() => {
    load();
  }, [load]);

  const params: GateParams = {
    covenantId: covenantId ?? "",
    eventName: event?.event.name ?? "",
  };

  const handleDecode = useCallback(
    async (raw: string) => {
      if (gate.phase === "waiting" || gate.phase === "co-signing") return;
      try {
        const payload = await decodeGatePayload(raw);
        logStep("decoded", { use_id: payload.use_id });
        const result = await prepareGateCheck(payload, params);
        setGate({
          phase: "waiting",
          ticket: result.ticket,
          event: result.event,
          payload,
        });
      } catch (err) {
        logError("decode", err);
        // Unparseable payloads → "Not a valid ticket code." (FR-23);
        // server outages → "No connection…" (mapped by errorMsg).
        setGate({ phase: "red", message: isDecodeFailure(err) ? decodeError() : errorMsg(err) });
      }
    },
    [gate.phase, params],
  );

  const camera = useCamera({ enabled: gate.phase === "scanning", onDecode: handleDecode });

  const handleCancel = useCallback(() => {
    setGate({ phase: "scanning" });
  }, []);

  if (loading) {
    return (
      <div>
        <div className="skeleton skeleton-title" aria-hidden="true" />
        <div className="skeleton skeleton-line" aria-hidden="true" />
      </div>
    );
  }

  if (offline || !event) {
    return offline ? (
      <OfflineEmpty onRetry={load} />
    ) : (
      <Empty
        title="Event not found."
        sub="It may have been removed or isn't on this network."
        actionLabel="Back to events"
        actionTo="/"
      />
    );
  }

  return (
    <div className="gate">
      <Link to={`/events/${covenantId}`} className="page-back">
        &larr; {event.event.name}
      </Link>

      <header className="token-hero">
        <h1 className="token-name">Door</h1>
        <p className="token-when">{event.event.name}</p>
      </header>

      {gate.phase === "red" && (
        <div className="verdict verdict-error" role="alert">
          <div className="verdict-icon">&#10007;</div>
          <p className="verdict-title">{gate.message}</p>
        </div>
      )}

      <div className="scan-panel">
        <video ref={camera.videoRef} className="scan-video" playsInline muted aria-hidden="true" />
        <canvas ref={camera.canvasRef} className="scan-canvas" aria-hidden="true" />
        {gate.phase === "waiting" ? (
          <div className="scan-status">
            <span className="spinner spinner-sm" />
            <span>Waiting for the gate to confirm…</span>
            <button type="button" className="button button-link button-sm" onClick={handleCancel}>
              Cancel
            </button>
          </div>
        ) : (
          <p className="scan-status">
            {camera.status.phase === "denied"
              ? "Camera access denied — allow it to scan tickets."
              : "Scan a check-in QR…"}
          </p>
        )}
      </div>
    </div>
  );
}
