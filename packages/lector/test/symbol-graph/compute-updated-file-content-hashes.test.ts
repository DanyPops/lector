import { describe, expect, it } from "bun:test";
import type { ContentHash } from "../../src/content-identity/content-hash.ts";
import { computeUpdatedFileContentHashes } from "../../src/symbol-graph/compute-updated-file-content-hashes.ts";

function hash(label: string): ContentHash {
	return label as ContentHash;
}

describe("computeUpdatedFileContentHashes", () => {
	it("carries a skipped file's previous hash forward unchanged", () => {
		const result = computeUpdatedFileContentHashes({ "/a.ts": hash("h1") }, ["/a.ts"], [], new Map(), [], false);
		expect(result).toEqual({ "/a.ts": hash("h1") });
	});

	it("records a reprocessed file's fresh hash when it succeeded", () => {
		const result = computeUpdatedFileContentHashes(undefined, [], ["/b.ts"], new Map([["/b.ts", hash("h2")]]), [], false);
		expect(result).toEqual({ "/b.ts": hash("h2") });
	});

	it("excludes a reprocessed file that failed", () => {
		const currentHashes = new Map([
			["/ok.ts", hash("h1")],
			["/bad.ts", hash("h2")],
		]);
		const failures = [{ path: "/bad.ts", operation: "document-symbols" as const, code: "E", message: "boom", provenance: undefined as never }];

		const result = computeUpdatedFileContentHashes(undefined, [], ["/ok.ts", "/bad.ts"], currentHashes, failures, false);

		expect(result).toEqual({ "/ok.ts": hash("h1") });
	});

	it("records nothing for the reprocessed batch when failures were truncated -- can't know who really succeeded", () => {
		const currentHashes = new Map([["/ok.ts", hash("h1")]]);
		const result = computeUpdatedFileContentHashes({ "/skipped.ts": hash("hs") }, ["/skipped.ts"], ["/ok.ts"], currentHashes, [], true);
		expect(result).toEqual({ "/skipped.ts": hash("hs") });
	});
});
