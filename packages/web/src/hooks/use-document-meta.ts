// React adapter for the document metadata engine (KTK-162).
//
// The engine in `lib/document-meta.ts` knows how to apply and restore tags; this
// hook decides when to do it and restores the generic values when the event is
// no longer visible.

import { useEffect } from "react";
import { applyDocumentMeta, type DocumentMeta } from "../lib/document-meta";

export type { DocumentMeta } from "../lib/document-meta";

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
