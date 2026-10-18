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

/** What an HTML-to-text reader sees when it drops `<noscript>` (GitHub issue #1). */
function withoutNoscript(html: string): string {
  return html.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, "").replace(/\s+/g, " ");
}

function metaContent(html: string, name: string): string | undefined {
  const tag = [...html.matchAll(/<meta\b[^>]*>/gi)]
    .map(([match]) => match)
    .find((candidate) => attribute(candidate, "name")?.toLowerCase() === name.toLowerCase());
  return tag === undefined ? undefined : attribute(tag, "content");
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
    const description = metaContent(SHELL, "description") ?? "";

    expect(description).toContain("HTTP API");
    expect(description).toContain("no browser required");
  });

  it("explains the product in body markup, not behind noscript", () => {
    // HTML-to-text readers and sanitizers drop <noscript>, so the explanation
    // must survive its removal (GitHub issue #1).
    const readable = withoutNoscript(SHELL);

    expect(readable).toContain("No browser is required");
    expect(readable).toContain("wallet signature");
    expect(readable).toContain("https://github.com/danieliyahu1/kticket");
    for (const path of AGENT_ENTRY_POINTS) {
      expect(readable, path).toContain(`href="${path}"`);
    }
  });
});
