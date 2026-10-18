// The site-root shell (issue #2).
//
// `/` is the SPA's built `index.html` with the same generic metadata an
// unknown event receives. Unfurlers do not run JavaScript, so the tags have to
// be in the document the server sends; the browser app never sets them on the
// home page.
//
// The HTML is rendered once at registration: the shell and the public origin
// are fixed for the life of the process, and the document still boots the SPA.
//
// Registered before the static handler, which leaves `/` to this route.

import { buildGenericMeta } from "@kticket/kit";
import type { FastifyInstance } from "fastify";
import { SHELL_CACHE_CONTROL } from "./docs-paths.js";
import { injectEventMeta } from "./event-preview-html.js";

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

export interface HomeShellOptions {
  /** Absolute origin used for the canonical and preview URLs. */
  origin: string;
  /** The built SPA shell (`index.html`). */
  shellHtml: string;
}

export function registerHomeShell(
  app: FastifyInstance,
  { origin, shellHtml }: HomeShellOptions,
): void {
  const html = injectEventMeta(shellHtml, buildGenericMeta(origin));

  app.get("/", (_req, reply) =>
    reply
      .header("cache-control", SHELL_CACHE_CONTROL)
      .header("content-type", HTML_CONTENT_TYPE)
      .send(html),
  );
}
