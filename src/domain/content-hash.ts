import { createHash } from "node:crypto";

/**
 * ContentHash — an opaque fingerprint of a workspace entry's content.
 * The domain does not care which algorithm produces it, only that two
 * reads of unchanged content agree and any content change disagrees.
 * Branded so a raw string can never be passed where a real hash is required.
 */
export type ContentHash = string & { readonly __brand: "ContentHash" };

/** Compute the ContentHash for a piece of workspace entry content. */
export function contentHashOf(content: string): ContentHash {
	return createHash("sha256").update(content, "utf-8").digest("hex") as ContentHash;
}
