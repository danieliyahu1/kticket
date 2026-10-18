// Clipboard access for the share action (KTK-161).
//
// The Clipboard API is unavailable in some embedded browsers and can be denied
// outright. Callers must handle rejection: the event page then shows a
// selectable input, so the link is never a dead end.

export async function copyText(text: string): Promise<void> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== "function") {
    throw new Error("Clipboard access is unavailable.");
  }
  await clipboard.writeText(text);
}
