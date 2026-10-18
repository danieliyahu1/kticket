// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { applyDocumentMeta, useDocumentMeta, type DocumentMeta } from "./use-document-meta";

const META_A: DocumentMeta = {
  title: "Event A — kticket",
  description: "Event A on 31 December 2026.",
  canonicalUrl: "https://kticket.example.com/events/a",
};

const META_B: DocumentMeta = {
  title: "Event B — kticket",
  description: "Event B on 1 January 2027.",
  canonicalUrl: "https://kticket.example.com/events/b",
};

beforeEach(() => {
  document.head.innerHTML =
    '<meta name="description" content="generic"><meta property="og:title" content="generic og">';
  document.title = "kticket";
});

describe("applyDocumentMeta (KTK-162)", () => {
  it("sets title, description, canonical, and existing preview tags", () => {
    const restore = applyDocumentMeta(document, META_A);

    expect(document.title).toBe(META_A.title);
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
      META_A.description,
    );
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      META_A.canonicalUrl,
    );
    expect(document.querySelector('meta[property="og:title"]')?.getAttribute("content")).toBe(
      META_A.title,
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

describe("useDocumentMeta (KTK-162)", () => {
  it("keeps metadata aligned across event A -> event B -> home", () => {
    const { rerender, unmount } = renderHook(
      ({ meta }: { meta: DocumentMeta | null }) => useDocumentMeta(meta),
      { initialProps: { meta: META_A as DocumentMeta | null } },
    );

    expect(document.title).toBe(META_A.title);
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      META_A.canonicalUrl,
    );

    rerender({ meta: META_B });
    expect(document.title).toBe(META_B.title);
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
      META_B.description,
    );
    expect(document.querySelector('link[rel="canonical"]')?.getAttribute("href")).toBe(
      META_B.canonicalUrl,
    );

    // Back/forward or a link home clears the event: generic values return.
    rerender({ meta: null });
    expect(document.title).toBe("kticket");
    expect(document.querySelector('meta[name="description"]')?.getAttribute("content")).toBe(
      "generic",
    );
    expect(document.querySelector('link[rel="canonical"]')).toBeNull();

    unmount();
    expect(document.title).toBe("kticket");
  });
});
