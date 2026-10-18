// The homepage is the front door for agents too (KTK-152). A client that reads
// the shell must find the published surface and learn that the app works
// without the UI, even when it never executes JavaScript.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SHELL = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const AGENT_ENTRY_POINTS = [
  "/llms.txt",
  "/docs/agent-guide.md",
  "/openapi.json",
  "/docs/api",
] as const;

interface LinkTag {
  rel: string | undefined;
  type: string | undefined;
  href: string | undefined;
}

function linkTags(html: string): LinkTag[] {
  return [...html.matchAll(/<link\b[^>]*>/gi)].map(([tag]) => ({
    rel: attribute(tag, "rel"),
    type: attribute(tag, "type"),
    href: attribute(tag, "href"),
  }));
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag)?.[1];
}

function noscriptBody(html: string): string {
  return /<noscript\b[^>]*>([\s\S]*?)<\/noscript>/i.exec(html)?.[1] ?? "";
}

describe("homepage discovery (KTK-152)", () => {
  it("points machines at the published surface from the HTML head", () => {
    const links = linkTags(SHELL);

    expect(links).toContainEqual({
      rel: "alternate",
      type: "text/plain",
      href: "/llms.txt",
    });
    expect(links).toContainEqual({
      rel: "alternate",
      type: "text/markdown",
      href: "/docs/agent-guide.md",
    });
    expect(links).toContainEqual({
      rel: "alternate",
      type: "application/json",
      href: "/openapi.json",
    });
  });

  it("says in the meta description that the API needs no browser", () => {
    expect(SHELL).toMatch(/<meta[^>]+name="description"[^>]+content="[^"]*HTTP API[^"]*"/i);
    expect(SHELL).toContain("no browser required");
  });

  it("tells a no-JS client that every flow works without the UI", () => {
    const fallback = noscriptBody(SHELL).replace(/\s+/g, " ");

    expect(fallback).toContain("No browser is required");
    expect(fallback).toContain("wallet signature");
    for (const path of AGENT_ENTRY_POINTS) {
      expect(fallback, path).toContain(`href="${path}"`);
    }
  });
});
