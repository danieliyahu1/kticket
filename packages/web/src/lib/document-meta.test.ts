// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { applyDocumentMeta, type DocumentMeta } from "./document-meta";

const META: DocumentMeta = {
  title: "Event A — kticket",
  description: "Event A on 31 December 2026.",
  canonicalUrl: "https://kticket.example.com/events/a",
};

beforeEach(() => {
  document.head.innerHTML =
    '<meta name="description" content="generic"><meta property="og:title" content="generic og">';
  document.title = "kticket";
});

describe("applyDocumentMeta (KTK-162)", () => {
  it("sets title, description, canonical, and existing preview tags", () => {
    const restore = applyDocumentMeta(document, META);

    expect(document.title).toBe(META.title);
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
      META.description,
    );
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      META.canonicalUrl,
    );
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe(
      META.title,
    );

    restore();

    expect(document.title).toBe("kticket");
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
      "generic",
    );
    // The canonical tag did not exist before, so restoring removes it.
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe(
      "generic og",
    );
  });
});
