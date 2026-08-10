// Anchor-based discovery links (KTK-89).
//
// Events are referenced by shareable anchor links (`/events/{covenant_id}`). The
// browser persists opened/bookmarked anchors locally so a shared link re-opens
// even when the identifier registry listing has moved on — the registry is just
// a discovery pointer, never authoritative.

export interface SavedAnchor {
  covenantId: string;
  deployTxid: string;
  name: string;
  savedAt: number;
}

const STORAGE_KEY = "kticket:anchors";
const MAX_ANCHORS = 50;

function read(): SavedAnchor[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isAnchor);
  } catch {
    return [];
  }
}

function isAnchor(value: unknown): value is SavedAnchor {
  if (typeof value !== "object" || value === null) return false;
  const a = value as Record<string, unknown>;
  return (
    typeof a.covenantId === "string" &&
    typeof a.deployTxid === "string" &&
    typeof a.name === "string" &&
    typeof a.savedAt === "number"
  );
}

function write(anchors: SavedAnchor[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(anchors));
  } catch {
    /* storage unavailable — anchors are best-effort */
  }
}

/** Persist a visited/bookmarked anchor (most-recent first, deduped). */
export function saveAnchor(anchor: SavedAnchor): SavedAnchor[] {
  const rest = read().filter((a) => a.covenantId !== anchor.covenantId);
  const next = [anchor, ...rest].slice(0, MAX_ANCHORS);
  write(next);
  return next;
}

export function listAnchors(): SavedAnchor[] {
  return read().sort((a, b) => b.savedAt - a.savedAt);
}

export function removeAnchor(covenantId: string): SavedAnchor[] {
  const next = read().filter((a) => a.covenantId !== covenantId);
  write(next);
  return next;
}

/** The shareable anchor URL for an event. */
export function anchorUrl(covenantId: string): string {
  return `${window.location.origin}${window.location.pathname.replace(/\/events\/.*/, "")}/events/${covenantId}`;
}
