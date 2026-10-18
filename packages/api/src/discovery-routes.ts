// Published discovery routes (KTK-163): the sitemap and the robots policy.
//
// Registered before the static SPA and its catch-all, beside the docs routes, so
// `/sitemap.xml` and `/robots.txt` are real documents rather than index.html.

import type { FastifyInstance } from "fastify";
import { robotsTxt, sitemapXml } from "./discovery.js";
import {
  DISCOVERY_CACHE_CONTROL,
  ROBOTS_TXT_PATH,
  SITEMAP_PATH,
} from "./docs-paths.js";
import { verifyAll, type VerificationContext } from "./verified-events.js";

const XML_CONTENT_TYPE = "application/xml; charset=utf-8";
const TEXT_CONTENT_TYPE = "text/plain; charset=utf-8";

export interface DiscoveryRouteOptions {
  ctx: VerificationContext;
  /** Absolute origin used for every URL in the document. */
  origin: string;
}

export function registerDiscoveryRoutes(
  app: FastifyInstance,
  { ctx, origin }: DiscoveryRouteOptions,
): void {
  app.get(SITEMAP_PATH, async (_req, reply) => {
    const verified = await verifyAll(ctx.events.list(), ctx);
    return reply
      .header("cache-control", DISCOVERY_CACHE_CONTROL)
      .header("content-type", XML_CONTENT_TYPE)
      .send(sitemapXml(verified, origin));
  });

  app.get(ROBOTS_TXT_PATH, async (_req, reply) =>
    reply
      .header("cache-control", DISCOVERY_CACHE_CONTROL)
      .header("content-type", TEXT_CONTENT_TYPE)
      .send(robotsTxt(origin, SITEMAP_PATH)),
  );
}
