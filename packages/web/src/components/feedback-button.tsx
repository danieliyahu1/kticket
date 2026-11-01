// Anonymous feedback, reachable from every page via the footer.
//
// It asks for one short note and nothing else. The API may accept the note but
// not deliver it yet, so the confirmation never claims it was sent when
// `delivered` is false.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { submitFeedback } from "../api/client";
import { showToast } from "./toast-store";

/** Mirrors FEEDBACK_MAX_MESSAGE in the API; the server is authoritative. */
const MAX_MESSAGE = 1500;

export const FEEDBACK_BUTTON_LABEL = "Send feedback";
export const FEEDBACK_DELIVERED_MESSAGE = "Thanks - your feedback was sent.";
export const FEEDBACK_QUEUED_MESSAGE =
  "Thanks - your feedback is saved. We'll deliver it as soon as we can.";
export const FEEDBACK_REQUIRED_MESSAGE = "Write a message first.";
export const FEEDBACK_FAILED_MESSAGE = "That didn't go through. Try again.";

const EMPTY = "";

export function FeedbackButton() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState(EMPTY);
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    textRef.current?.focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !sending) {
        setOpen(false);
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;

      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previous?.focus();
    };
  }, [open, sending]);

  function show() {
    setMessage(EMPTY);
    setNote(null);
    setSending(false);
    setOpen(true);
  }

  function close() {
    if (sending) return;
    setOpen(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = message.trim();
    if (trimmed.length === 0) {
      setNote(FEEDBACK_REQUIRED_MESSAGE);
      textRef.current?.focus();
      return;
    }

    setSending(true);
    setNote(null);
    try {
      const result = await submitFeedback(trimmed);
      setOpen(false);
      setMessage(EMPTY);
      showToast(result.delivered ? FEEDBACK_DELIVERED_MESSAGE : FEEDBACK_QUEUED_MESSAGE, {
        tone: result.delivered ? "success" : "notice",
      });
    } catch (error) {
      setNote(error instanceof Error ? error.message : FEEDBACK_FAILED_MESSAGE);
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="footer-link feedback-button"
        onClick={show}
        aria-haspopup="dialog"
      >
        {FEEDBACK_BUTTON_LABEL}
      </button>
      {open && (
        <div
          className="overlay"
          role="dialog"
          aria-modal="true"
          aria-labelledby="feedback-title"
        >
          <div className="dialog" ref={dialogRef} tabIndex={-1}>
            <button
              type="button"
              className="dialog-close"
              onClick={close}
              aria-label="Close"
              disabled={sending}
            >
              &times;
            </button>
            <h2 id="feedback-title" className="dialog-title">
              Send feedback
            </h2>
            <p className="dialog-copy">
              A bug, an idea, or something that felt confusing. No account needed.
            </p>
            <form onSubmit={(event) => void submit(event)} noValidate>
              <div className="field">
                <label className="field-label" htmlFor="feedback-message">
                  Your message
                </label>
                <textarea
                  id="feedback-message"
                  ref={textRef}
                  className="input"
                  name="message"
                  rows={5}
                  maxLength={MAX_MESSAGE}
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  placeholder="What happened?"
                  aria-describedby="feedback-hint"
                />
                <p id="feedback-hint" className="field-hint">
                  {message.length}/{MAX_MESSAGE}
                </p>
              </div>
              {note && (
                <p className="field-error" role="alert">
                  {note}
                </p>
              )}
              <div className="form-actions">
                <button type="submit" className="button button-primary" disabled={sending}>
                  {sending ? "Sending..." : "Send"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
