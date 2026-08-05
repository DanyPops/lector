import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ContentHash } from "../domain/content-hash.ts";
import { findSourceFiles } from "../text-search/find-source-files.ts";

export interface SourceManifest {
	readonly fingerprint: string;
	readonly absoluteFiles: readonly string[];
	/** Each file's own content hash, same algorithm as contentHashOf -- lets a caller diff which specific files changed since a prior manifest, not just whether the tree as a whole did. */
	readonly fileHashes: ReadonlyMap<string, ContentHash>;
}

export class SourceManifestLimitExceeded extends Error {
	constructor(readonly maxBytes: number) {
		super(`source manifest exceeds the ${maxBytes}-byte hashing bound`);
		this.name = "SourceManifestLimitExceeded";
	}
}

/** Hashes the same bounded, sorted source-file set population will consume. */
export async function deriveSourceManifest(rootPath: string, extensions: readonly string[], maxFiles: number, maxBytes: number): Promise<SourceManifest> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
	const relativeFiles = findSourceFiles(rootPath, (extension) => extensions.includes(extension), maxFiles);
	const hash = createHash("sha256");
	const absoluteFiles: string[] = [];
	const fileHashes = new Map<string, ContentHash>();
	let bytesHashed = 0;
	for (const relativePath of relativeFiles) {
		const absolutePath = join(rootPath, relativePath);
		const expectedSize = (await stat(absolutePath)).size;
		if (bytesHashed + expectedSize > maxBytes) throw new SourceManifestLimitExceeded(maxBytes);
		hash.update(String(Buffer.byteLength(relativePath)));
		hash.update(":");
		hash.update(relativePath);
		hash.update(":");
		hash.update(String(expectedSize));
		hash.update(":");
		const fileHash = createHash("sha256");
		for await (const chunk of createReadStream(absolutePath)) {
			// Binary stream (no setEncoding above) always yields Buffer; Node types it as any regardless.
			if (!(chunk instanceof Buffer)) throw new TypeError("expected a Buffer chunk from a binary read stream");
			bytesHashed += chunk.byteLength;
			if (bytesHashed > maxBytes) throw new SourceManifestLimitExceeded(maxBytes);
			hash.update(chunk);
			fileHash.update(chunk);
		}
		// Same sha256-hex-of-content algorithm as contentHashOf, computed from the identical bytes
		// already streamed above rather than re-reading the file as a second pass.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
		fileHashes.set(absolutePath, fileHash.digest("hex") as ContentHash);
		absoluteFiles.push(absolutePath);
	}
	return { fingerprint: hash.digest("hex"), absoluteFiles, fileHashes };
}
