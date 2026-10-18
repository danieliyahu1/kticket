// The canonical URL of an event page (KTK-161).
//
// The share action and the document metadata both build the link here, so they
// cannot disagree, and both use the same path helper the server uses for
// canonical tags and the sitemap.

import { eventPath } from "@kticket/kit";

/** Join an origin and an event path without duplicating slashes. */
export function canonicalEventUrl(origin: string, covenantId: string): string {
  return `${origin.trim().replace(/\/+$/, "")}${eventPath(covenantId)}`;
}
