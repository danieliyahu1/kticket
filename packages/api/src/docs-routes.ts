// Published documentation routes (KTK-152 / KTK-155 / KTK-157).
//
// These are registered before the static SPA and its catch-all handler, so
// `/docs/api`, `/docs/agent-guide.md`, `/llms.txt`, and the contract paths are
// real routes rather than the SPA's index.html. No auth: the surface is public,
// exactly like the browser app's own reads.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { agentGuideMarkdown } from "./agent-guide.js";
import { apiDocsHtml } from "./docs-page.js";
import {
  AGENT_GUIDE_PATH,
  API_DOCS_PATH,
  DOCS_CACHE_CONTROL,
  LLMS_TXT_PATH,
  OPENAPI_PATH,
  OPENAPI_WELL_KNOWN_PATH,
} from "./docs-paths.js";
import { llmsTxt } from "./llms.js";
import { openApiDocument, type OpenApiOptions } from "./openapi.js";

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const HTML_CONTENT_TYPE = "text/html; charset=utf-8";
const MARKDOWN_CONTENT_TYPE = "text/markdown; charset=utf-8";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

function sendCached(
  reply: FastifyReply,
  contentType: string,
  body: string,
): FastifyReply {
  return reply
    .header("cache-control", DOCS_CACHE_CONTROL)
    .header("content-type", contentType)
    .send(body);
}

export function registerDocsRoutes(app: FastifyInstance, ctx: OpenApiOptions): void {
  const openApi = openApiDocument(ctx);
  // Serialized once at boot: the contract only changes on deploy, and serving a
  // stable string keeps the cache cheap.
  const openApiJson = `${JSON.stringify(openApi, null, 2)}\n`;
  const docsHtml = apiDocsHtml(openApi, ctx.origin);
  const llms = llmsTxt(ctx.origin, ctx.network);

  const serveOpenApiDocument = (_req: FastifyRequest, reply: FastifyReply) =>
    sendCached(reply, JSON_CONTENT_TYPE, openApiJson);

  app.get(OPENAPI_PATH, serveOpenApiDocument);
  app.get(OPENAPI_WELL_KNOWN_PATH, serveOpenApiDocument);

  app.get(API_DOCS_PATH, (_req, reply) => sendCached(reply, HTML_CONTENT_TYPE, docsHtml));

  app.get(AGENT_GUIDE_PATH, (_req, reply) =>
    sendCached(reply, MARKDOWN_CONTENT_TYPE, agentGuideMarkdown),
  );

  app.get(LLMS_TXT_PATH, (_req, reply) => sendCached(reply, TEXT_CONTENT_TYPE, llms));
}
