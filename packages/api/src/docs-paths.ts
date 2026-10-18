// The published documentation surface (KTK-152). One place names every path so
// the routes, the llms.txt map, the docs page, and the tests cannot drift.

/** The OpenAPI document. Also served at OPENAPI_WELL_KNOWN_PATH. */
export const OPENAPI_PATH = "/openapi.json";
export const OPENAPI_WELL_KNOWN_PATH = "/.well-known/openapi.json";
/** The human-readable API reference, rendered by the server. */
export const API_DOCS_PATH = "/docs/api";
/** The agent guide, served as markdown from `docs/agent-guide.md`. */
export const AGENT_GUIDE_PATH = "/docs/agent-guide.md";
/** The plain-text map an agent reads first. */
export const LLMS_TXT_PATH = "/llms.txt";
/** Search-engine discovery for verified events (KTK-163). */
export const SITEMAP_PATH = "/sitemap.xml";
export const ROBOTS_TXT_PATH = "/robots.txt";

/** Docs are cacheable, but a deploy should not leave clients stale for long. */
export const DOCS_CACHE_CONTROL = "public, max-age=300";
/** Discovery documents change only when events are registered; keep it short. */
export const DISCOVERY_CACHE_CONTROL = "public, max-age=300";
/** Event shells are per-event and safe to cache briefly (fallbacks recover fast). */
export const EVENT_SHELL_CACHE_CONTROL = "public, max-age=60";
