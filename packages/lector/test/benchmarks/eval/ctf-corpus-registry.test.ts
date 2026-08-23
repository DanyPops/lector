import { describe, expect, it } from "bun:test";
import { CTF_CORPORA, resolveCtfCorpus, UnknownCtfCorpus } from "../../../benchmarks/eval/ctf-corpus-registry.ts";

describe("resolveCtfCorpus", () => {
	it("resolves the existing small:typescript corpus with zero behavior change", () => {
		const module = resolveCtfCorpus("small:typescript");
		expect(module.tasks.length).toBeGreaterThan(0);
		const fixture = module.materializeFixture();
		try {
			expect(fixture.root.length).toBeGreaterThan(0);
		} finally {
			fixture.dispose();
		}
	});

	it("lists every registered corpus key", () => {
		expect(Object.keys(CTF_CORPORA)).toContain("small:typescript");
	});

	it("throws a clear, typed error for an unknown corpus key rather than returning undefined", () => {
		expect(() => resolveCtfCorpus("large:cobol")).toThrow(UnknownCtfCorpus);
	});
});
