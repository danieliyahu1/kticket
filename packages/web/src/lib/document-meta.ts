// Document metadata as a small, framework-free engine (KTK-162).
//
// The server injects the same values into the shell for crawlers. Inside the SPA
// the URL changes without a document load, so this module applies the values
// for the current event and returns a restore function. The React adapter lives
// in `hooks/use-document-meta.ts`.

export interface DocumentMeta {
  title: string;
  description: string;
  canonicalUrl: string;
  imageUrl?: string;
  twitterCard?: "summary" | "summary_large_image";
}

interface HeadTag {
  selector: string;
  attribute: string;
  /** `null` removes the tag; it is restored on cleanup. */
  value: string | null;
  /** Tags that must exist even in a shell that does not carry preview tags. */
  create?: () => Element;
}

/** Apply metadata and return a restore function. */
export function applyDocumentMeta(doc: Document, meta: DocumentMeta): () => void {
  const restores: (() => void)[] = [];
  syncTitle(doc, meta.title, restores);

  for (const tag of headTags(doc, meta)) syncHeadTag(doc, tag, restores);

  return () => {
    // Restore in reverse: if two rules touched the same element, the earliest
    // snapshot is the one that matters.
    for (const restore of restores.reverse()) restore();
  };
}

/** The full set of tags the shell renders, in the order they should appear. */
function headTags(doc: Document, meta: DocumentMeta): HeadTag[] {
  return [
    {
      selector: 'meta[name="description"]',
      attribute: "content",
      value: meta.description,
      create: () => createMetaElement(doc, "name", "description"),
    },
    {
      selector: 'link[rel="canonical"]',
      attribute: "href",
      value: meta.canonicalUrl,
      create: () => createCanonicalLink(doc),
    },
    metaTag("property", "og:title", meta.title),
    metaTag("name", "twitter:title", meta.title),
    metaTag("property", "og:description", meta.description),
    metaTag("name", "twitter:description", meta.description),
    metaTag("property", "og:url", meta.canonicalUrl),
    metaTag("property", "og:image", meta.imageUrl ?? null),
    metaTag("name", "twitter:image", meta.imageUrl ?? null),
    metaTag("name", "twitter:card", meta.twitterCard ?? null),
  ];
}

function metaTag(
  attributeName: "name" | "property",
  name: string,
  value: string | null,
): HeadTag {
  return {
    selector: `meta[${attributeName}="${name}"]`,
    attribute: "content",
    value,
  };
}

function syncTitle(doc: Document, title: string, restores: (() => void)[]): void {
  const previous = doc.title;
  doc.title = title;
  restores.push(() => {
    doc.title = previous;
  });
}

function syncHeadTag(doc: Document, tag: HeadTag, restores: (() => void)[]): void {
  const target = findOrCreateHeadTag(doc, tag);
  if (target === null) return;

  if (tag.value === null) {
    if (target.created) target.element.remove();
    else rememberRemoval(target.element, restores);
    return;
  }

  if (target.created) {
    target.element.setAttribute(tag.attribute, tag.value);
    restores.push(() => target.element.remove());
    return;
  }

  rememberAttribute(target.element, tag.attribute, restores);
  target.element.setAttribute(tag.attribute, tag.value);
}

interface HeadTagTarget {
  element: Element;
  created: boolean;
}

function findOrCreateHeadTag(doc: Document, tag: HeadTag): HeadTagTarget | null {
  const existing = doc.head.querySelector(tag.selector);
  if (existing !== null) return { element: existing, created: false };
  if (tag.create === undefined) return null;

  const element = tag.create();
  doc.head.appendChild(element);
  return { element, created: true };
}

function rememberRemoval(element: Element, restores: (() => void)[]): void {
  const parent = element.parentNode;
  const next = element.nextSibling;
  element.remove();
  restores.push(() => {
    if (parent === null) return;
    if (next !== null && next.parentNode === parent) parent.insertBefore(element, next);
    else parent.appendChild(element);
  });
}

function rememberAttribute(
  element: Element,
  attribute: string,
  restores: (() => void)[],
): void {
  const previous = element.getAttribute(attribute);
  restores.push(() => {
    if (previous === null) element.removeAttribute(attribute);
    else element.setAttribute(attribute, previous);
  });
}

function createMetaElement(doc: Document, attribute: string, value: string): Element {
  const element = doc.createElement("meta");
  element.setAttribute(attribute, value);
  return element;
}

function createCanonicalLink(doc: Document): Element {
  const element = doc.createElement("link");
  element.setAttribute("rel", "canonical");
  return element;
}
