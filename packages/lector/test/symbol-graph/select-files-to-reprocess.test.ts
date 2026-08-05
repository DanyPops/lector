import { describe, expect, it } from "bun:test";
import type { ContentHash } from "../../src/content-identity/content-hash.ts";
import { diffFileHashes } from "../../src/symbol-graph/select-files-to-reprocess.ts";

function hash(label: string): ContentHash {
	return label as ContentHash;
}

describe("diffFileHashes", () => {
	it("treats every file as changed when there is no previous generation", () => {
		const result = diffFileHashes(["/a.ts", "/b.ts"], new Map([["/a.ts", hash("h1")]]), undefined);
		expect(result).toEqual({ changed: ["/a.ts", "/b.ts"], unchanged: [] });
	});

	it("marks a file unchanged only when both current and previous hashes exist and match", () => {
		const currentHashes = new Map([
			["/a.ts", hash("h1")],
			["/b.ts", hash("h2-new")],
		]);
		const previousHashes = { "/a.ts": hash("h1"), "/b.ts": hash("h2-old") };

		const result = diffFileHashes(["/a.ts", "/b.ts"], currentHashes, previousHashes);

		expect(result.unchanged).toEqual(["/a.ts"]);
		expect(result.changed).toEqual(["/b.ts"]);
	});

	it("treats a new file (absent from previousHashes) as changed", () => {
		const result = diffFileHashes(["/new.ts"], new Map([["/new.ts", hash("h1")]]), {});
		expect(result).toEqual({ changed: ["/new.ts"], unchanged: [] });
	});

	it("treats a file with no current hash (should not happen, but fails closed) as changed", () => {
		const result = diffFileHashes(["/a.ts"], new Map(), { "/a.ts": hash("h1") });
		expect(result).toEqual({ changed: ["/a.ts"], unchanged: [] });
	});
});
