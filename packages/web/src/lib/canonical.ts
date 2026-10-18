// The canonical URL of an event page (KTK-161).
//
// The share action and the document metadata both build the link here, so they
// cannot disagree. The path helper and the absolute-URL rules come from the same
// shared module the server uses for canonical tags and the sitemap.

export { eventUrl as canonicalEventUrl } from "@kticket/kit";
