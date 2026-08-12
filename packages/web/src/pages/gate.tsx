import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchEvent, ServerError, type EventDetail } from "../api/client";
import {
  coSignAndFinalize,
  decodeError,
  decodeGatePayload,
  errorMsg,
  isDecodeFailure,
  logError,
  logStep,
  prepareGateCheck,
  type GateParams,
  type GateState,
} from "../api/gate-machine";
import { Empty, OfflineEmpty } from "../components/empty";
import { useCamera } from "../hooks/use-camera";

const VERDICT_RESET_MS = 5_000;
const CO_SIGN_TIMEOUT_MS = 30_000;

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

  // Auto-reset the verdict back to scanning after a timeout (KTK-132). Green
  // only ever follows a DAG-confirmed mark_used — there is no liveness-read path.
  useEffect(() => {
    if (gate.phase !== "green" && gate.phase !== "red") return;
    const timer = setTimeout(() => setGate({ phase: "scanning" }), VERDICT_RESET_MS);
    return () => clearTimeout(timer);
  }, [gate]);

  // A dialog or co-sign that stalls resets to scanning (timeout → reset).
  useEffect(() => {
    if (gate.phase !== "waiting" && gate.phase !== "co-signing") return;
    const timer = setTimeout(() => setGate({ phase: "scanning" }), CO_SIGN_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [gate]);

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
        // Unparseable payloads / foreign tickets → "Not a valid ticket code."
        // (FR-23); server outages → "No connection…" (mapped by errorMsg).
        setGate({ phase: "red", message: isDecodeFailure(err) ? decodeError() : errorMsg(err) });
      }
    },
    [gate.phase, params],
  );

  const camera = useCamera({ enabled: gate.phase === "scanning", onDecode: handleDecode });

  const handleApprove = useCallback(async () => {
    if (gate.phase !== "waiting") return;
    setGate({ phase: "co-signing", ...pick(gate) });
    try {
      const result = await coSignAndFinalize(gate.payload);
      logStep("finalized", { txid: result.txid });
      setGate({ phase: "green", txid: result.txid });
    } catch (err) {
      logError("finalize", err);
      setGate({ phase: "red", message: errorMsg(err) });
    }
  }, [gate]);

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

      {gate.phase === "green" && (
        <div className="verdict verdict-ok" role="status">
          <div className="verdict-icon">&#10003;</div>
          <p className="verdict-title">You&rsquo;re in.</p>
          <p className="verdict-detail mono">{gate.txid}</p>
        </div>
      )}

      {gate.phase === "red" && (
        <div className="verdict verdict-error" role="alert">
          <div className="verdict-icon">&#10007;</div>
          <p className="verdict-title">{gate.message}</p>
        </div>
      )}

      {(gate.phase === "scanning" || gate.phase === "waiting" || gate.phase === "co-signing") && (
        <div className="scan-panel">
          <video ref={camera.videoRef} className="scan-video" playsInline muted aria-hidden="true" />
          <canvas ref={camera.canvasRef} className="scan-canvas" aria-hidden="true" />
          {gate.phase === "scanning" ? (
            <p className="scan-status">
              {camera.status.phase === "denied"
                ? "Camera access denied — allow it to scan tickets."
                : "Scan a check-in QR…"}
            </p>
          ) : gate.phase === "co-signing" ? (
            <p className="scan-status">
              <span className="spinner spinner-sm" />
              <span>Confirming in the wallet…</span>
            </p>
          ) : (
            <p className="scan-status">Ticket verified for {gate.event}.</p>
          )}
        </div>
      )}

      {gate.phase === "waiting" && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Authorize entry">
          <div className="dialog">
            <h3 className="dialog-title">Authorize entry for {gate.event}?</h3>
            <p className="dialog-copy">
              Approve to co-sign this check-in with your organizer wallet.
            </p>
            <div className="form-actions">
              <button
                type="button"
                className="button button-secondary"
                onClick={handleCancel}
                disabled={false}
              >
                Cancel
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={handleApprove}
                disabled={false}
              >
                Approve
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function pick(state: Extract<GateState, { phase: "waiting" }>): {
  ticket: string;
  event: string;
  payload: typeof state.payload;
} {
  return { ticket: state.ticket, event: state.event, payload: state.payload };
}
