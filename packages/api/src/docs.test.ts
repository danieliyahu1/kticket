// Every published document must be served from the app itself, with the right
// content type, and must actually contain the surface it promises (KTK-155 /
// KTK-157). The docs page is checked for endpoints and error codes rather than
// mere existence: a contract nobody can read is not published.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentGuideMarkdown } from "./agent-guide.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  AGENT_GUIDE_PATH,
  API_DOCS_PATH,
  DOCS_CACHE_CONTROL,
  LLMS_TXT_PATH,
  OPENAPI_PATH,
  OPENAPI_WELL_KNOWN_PATH,
} from "./docs-paths.js";
import { isJsonObject, type JsonObject } from "./json.js";
import { openApiDocument } from "./openapi.js";
import { FakeKaspa, NETWORK, buildAppWith } from "./test-chain.js";
import { documentedOperations } from "./test-openapi.js";

vi.mock("./wrpc-client.js", () => ({
  submitTransactionOverWrpc: vi.fn(),
}));

vi.mock("./compiler.js", async () => {
  const { createCompilerMock } = await import("./test-artifacts.js");
  return createCompilerMock();
});

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** Run a test against a booted app and always close it, even on failure. */
async function withApp(run: (app: FastifyInstance) => Promise<void>): Promise<void> {
  const app = await buildAppWith(new FakeKaspa());
  try {
    await run(app);
  } finally {
    await app.close();
  }
}

/** A stand-in production build: the SPA owns index.html and the catch-all. */
function spaDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kticket-spa-"));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>kticket SPA</title>");
  return directory;
}

/** The real built shell, so the test follows the links the app actually ships. */
function realSpaDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "kticket-web-"));
  temporaryDirectories.push(directory);
  const shell = readFileSync(new URL("../../web/index.html", import.meta.url), "utf8");
  writeFileSync(join(directory, "index.html"), shell);
  return directory;
}

describe("published documentation routes (KTK-155 / KTK-157)", () => {
  it("serves the OpenAPI document at all three addresses", async () => {
    await withApp(async (app) => {
      const canonical = await app.inject({ method: "GET", url: OPENAPI_PATH });
      expect(canonical.statusCode).toBe(200);
      expect(canonical.headers["content-type"]).toContain("application/json");
      expect(canonical.headers["cache-control"]).toBe(DOCS_CACHE_CONTROL);

      const document = canonical.json() as JsonObject;
      expect(document.openapi).toBe("3.1.0");

      for (const path of [OPENAPI_PATH, OPENAPI_WELL_KNOWN_PATH]) {
        const response = await app.inject({ method: "GET", url: path });
        expect(response.statusCode, path).toBe(200);
        expect(response.headers["content-type"], path).toContain("application/json");
        expect(response.headers["cache-control"], path).toBe(DOCS_CACHE_CONTROL);
        expect(response.json()).toEqual(document);
      }
    });
  });

  it("renders every endpoint and error code in a self-contained page", async () => {
    await withApp(async (app) => {
      const document = openApiDocument({
        origin: "http://localhost:3000",
        network: NETWORK,
        networkId: "testnet-10",
      });

      const response = await app.inject({ method: "GET", url: API_DOCS_PATH });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/html");
      expect(response.headers["cache-control"]).toBe(DOCS_CACHE_CONTROL);

      const html = response.body;
      // The whole contract is in the page: every method, path, operation, status.
      for (const { path, method, operation } of documentedOperations(document)) {
        expect(html, `${method} ${path}`).toContain(path);
        expect(html, `${method} ${path}`).toContain(`method-${method}`);
        expect(html, `${method} ${path}`).toContain(`>${method.toUpperCase()}</span>`);
        expect(html, `${operation.operationId}`).toContain(String(operation.operationId));
        const responses = isJsonObject(operation.responses) ? operation.responses : {};
        for (const status of Object.keys(responses)) {
          expect(html, `${path} ${status}`).toContain(status);
        }
      }

      for (const type of ["invalid", "conflict", "policy", "network", "upstream", "unauthorized"]) {
        expect(html, type).toContain(type);
      }

      // Self-contained: no scripts, no CDN, no external assets.
      expect(html).not.toContain("<script");
      expect(html).not.toContain("cdn.");
      expect(html).not.toContain('<link rel="stylesheet"');

      // Links back to the other published artifacts.
      expect(html).toContain(OPENAPI_PATH);
      expect(html).toContain(AGENT_GUIDE_PATH);
      expect(html).toContain(LLMS_TXT_PATH);
    });
  });

  it("serves llms.txt as plain text with resolvable links", async () => {
    await withApp(async (app) => {
      const response = await app.inject({ method: "GET", url: LLMS_TXT_PATH });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/plain");
      expect(response.headers["cache-control"]).toBe(DOCS_CACHE_CONTROL);

      const text = response.body;
      expect(text).toContain("# kticket");
      expect(text).toContain("POST");
      expect(text).toContain("/v1/auth/challenge");
      expect(text).toContain("/v1/events/{covenant_id}/buy/prepare");
      expect(text).toContain(NETWORK);

      // The guide names every flow and the real field names a client sends back.
      for (const path of [
        "/v1/events/deploy/prepare",
        "/v1/tickets/{ticket_id}/use/prepare",
        "/v1/tickets/{ticket_id}/list/prepare",
        "/v1/tickets/{ticket_id}/delist/prepare",
        "/v1/tickets/{ticket_id}/purchase/prepare",
      ]) {
        expect(text, path).toContain(path);
      }
      for (const field of [
        "buy_id",
        "deploy_id",
        "use_id",
        "signing_template",
        "sign_inputs",
        "price_kas",
        "publicKey",
        "address",
      ]) {
        expect(text, field).toContain(field);
      }

      // Every markdown link target is served by this same app.
      const links = [...text.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((match) => match[1]!);
      expect(links.length).toBeGreaterThanOrEqual(3);
      for (const link of links) {
        const url = new URL(link);
        const target = await app.inject({ method: "GET", url: `${url.pathname}${url.search}` });
        expect(target.statusCode, link).toBe(200);
      }
    });
  });

  it("serves the agent guide as markdown from docs/agent-guide.md", async () => {
    await withApp(async (app) => {
      const response = await app.inject({ method: "GET", url: AGENT_GUIDE_PATH });
      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toContain("text/markdown");
      expect(response.headers["cache-control"]).toBe(DOCS_CACHE_CONTROL);
      expect(response.body).toBe(agentGuideMarkdown);
      expect(response.body).toContain("## Authentication");
      expect(response.body).toContain("## Errors");
    });
  });

  it("keeps the docs routes ahead of the SPA catch-all", async () => {
    const directory = spaDirectory();
    const config = loadConfig({ KASPANET: NETWORK, AUTH_SECRET: "test-secret-for-kticket-api" });
    const app = await buildApp(config, undefined, { serveStatic: directory });

    try {
      for (const path of [
        OPENAPI_PATH,
        OPENAPI_WELL_KNOWN_PATH,
        API_DOCS_PATH,
        AGENT_GUIDE_PATH,
        LLMS_TXT_PATH,
      ]) {
        const response = await app.inject({ method: "GET", url: path });
        expect(response.statusCode, path).toBe(200);
        expect(response.body, path).not.toContain("kticket SPA");
      }

      // An event URL is a real route now (KTK-159): an unknown event still
      // returns the SPA shell, with generic metadata, and never the docs.
      const spa = await app.inject({ method: "GET", url: "/events/anything" });
      expect(spa.statusCode).toBe(200);
      expect(spa.body).toContain("<title>kticket — tickets on the chain</title>");
    } finally {
      await app.close();
    }
  });

  it("serves a homepage that advertises the published surface", async () => {
    const directory = realSpaDirectory();
    const config = loadConfig({ KASPANET: NETWORK, AUTH_SECRET: "test-secret-for-kticket-api" });
    const app = await buildApp(config, undefined, { serveStatic: directory });

    try {
      const home = await app.inject({ method: "GET", url: "/" });
      expect(home.statusCode).toBe(200);
      expect(home.headers["content-type"]).toContain("text/html");
      expect(home.body).toContain("No browser is required");

      for (const path of [LLMS_TXT_PATH, AGENT_GUIDE_PATH, OPENAPI_PATH, API_DOCS_PATH]) {
        expect(home.body, path).toContain(`href="${path}"`);
        const target = await app.inject({ method: "GET", url: path });
        expect(target.statusCode, path).toBe(200);
      }
    } finally {
      await app.close();
    }
  });
});
