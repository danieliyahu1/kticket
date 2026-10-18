// Share action for the event hero (KTK-161).
//
// Copies the canonical event URL. Clipboard denial is recoverable: the link is
// shown in a focused, selectable input, and the failure is announced through
// the same toast channel as the success.

import { useEffect, useRef, useState } from "react";
import { canonicalEventUrl } from "../lib/canonical";
import { copyText } from "../lib/share";
import { showToast } from "./toast-store";

export function ShareEventButton({ covenantId }: { covenantId: string }) {
  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (fallbackUrl === null) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [fallbackUrl]);

  async function copyShareLink(): Promise<void> {
    const url = canonicalEventUrl(window.location.origin, covenantId);
    try {
      await copyText(url);
      setFallbackUrl(null);
      showToast("Link copied. Send it anywhere.", { tone: "success" });
    } catch {
      setFallbackUrl(url);
      showToast("Couldn't copy the link. Select it below and copy.", { tone: "error" });
    }
  }

  return (
    <div className="share-action">
      <button
        type="button"
        className="button button-secondary button-sm"
        onClick={() => void copyShareLink()}
      >
        Share event
      </button>
      {fallbackUrl !== null && (
        <div className="share-fallback">
          <label className="share-fallback-label" htmlFor="share-event-url">
            Event link
          </label>
          <input
            id="share-event-url"
            ref={inputRef}
            className="share-fallback-input"
            type="text"
            readOnly
            value={fallbackUrl}
            onFocus={(event) => event.currentTarget.select()}
          />
        </div>
      )}
    </div>
  );
}
