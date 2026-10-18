// Keep document metadata in step with the visible page (KTK-162).
//
// The server injects the same values into the shell for crawlers. Inside the
// SPA the URL changes without a document load, so this hook applies the values
// for the current event and restores the previous ones on unmount. Navigating
// event A -> event B -> home therefore never leaves A's preview behind.

import { useEffect } from "react";

export interface DocumentMeta {
  title: string;
  description: string;
  canonicalUrl: string;
  imageUrl?: string;
  twitterCard?: "summary" | "summary_large_image";
}

/** Apply metadata and return a restore function. Exported for tests. */
export function applyDocumentMeta(doc: Document, meta: DocumentMeta): () => void {
  const restores: (() => void)[] = [];
  const previousTitle = doc.title;
  restores.push(() => {
    doc.title = previousTitle;
  });
  doc.title = meta.title;

  setSyncedTag(doc, 'meta[name="description"]', "content", meta.description, () => {
    const element = doc.createElement("meta");
    element.setAttribute("name", "description");
    return element;
  }, restores);
  setSyncedTag(doc, 'link[rel="canonical"]', "href", meta.canonicalUrl, () => {
    const element = doc.createElement("link");
    element.setAttribute("rel", "canonical");
    return element;
  }, restores);

  // The shell already carries preview tags; keep them consistent during client
  // navigation without inventing tags in a development shell that lacks them.
  for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]']) {
    setSyncedTag(doc, selector, "content", meta.title, null, restores);
  }
  for (const selector of ['meta[property="og:description"]', 'meta[name="twitter:description"]']) {
    setSyncedTag(doc, selector, "content", meta.description, null, restores);
  }
  setSyncedTag(doc, 'meta[property="og:url"]', "content", meta.canonicalUrl, null, restores);
  // A different event may have no image (or a different card type). Update when
  // present and remove stale tags when not, restoring them on unmount.
  for (const selector of ['meta[property="og:image"]', 'meta[name="twitter:image"]']) {
    setSyncedTag(doc, selector, "content", meta.imageUrl ?? null, null, restores);
  }
  setSyncedTag(
    doc,
    'meta[name="twitter:card"]',
    "content",
    meta.twitterCard ?? null,
    null,
    restores,
  );

  return () => {
    // Restore in reverse: if two rules touched the same element, the earliest
    // snapshot is the one that matters.
    for (const restore of restores.reverse()) restore();
  };
}

function setSyncedTag(
  doc: Document,
  selector: string,
  attribute: string,
  value: string | null,
  create: (() => Element) | null,
  restores: (() => void)[],
): void {
  let element = doc.head.querySelector(selector);
  const created = element === null && create !== null;
  if (element === null) {
    if (create === null) return;
    element = create();
    doc.head.appendChild(element);
  }

  if (value === null) {
    if (created) return;
    const parent = element.parentNode;
    const next = element.nextSibling;
    element.remove();
    restores.push(() => {
      if (parent) parent.insertBefore(element as Element, next);
    });
    return;
  }

  const previous = created ? null : element.getAttribute(attribute);
  element.setAttribute(attribute, value);
  restores.push(() => {
    if (created) {
      element?.remove();
    } else if (previous === null) {
      element?.removeAttribute(attribute);
    } else {
      element?.setAttribute(attribute, previous);
    }
  });
}

/**
 * Apply the metadata for the current route. Passing `null` (loading or a failed
 * load) applies nothing; the previous effect's cleanup restores the generic
 * values.
 */
export function useDocumentMeta(meta: DocumentMeta | null): void {
  const title = meta?.title;
  const description = meta?.description;
  const canonicalUrl = meta?.canonicalUrl;
  const imageUrl = meta?.imageUrl;
  const twitterCard = meta?.twitterCard;

  useEffect(() => {
    if (title === undefined || description === undefined || canonicalUrl === undefined) return;
    return applyDocumentMeta(document, {
      title,
      description,
      canonicalUrl,
      ...(imageUrl ? { imageUrl } : {}),
      ...(twitterCard ? { twitterCard } : {}),
    });
  }, [title, description, canonicalUrl, imageUrl, twitterCard]);
}
