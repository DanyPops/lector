import { describe, expect, it } from "bun:test";
import { formatSemanticModelContent } from "../extension/src/presentation/model-content.ts";

describe("formatSemanticModelContent", () => {
	it("formats nested outcomes as bounded semantic text rather than transport JSON", () => {
		const text = formatSemanticModelContent("Repository Fetch", {
			status: "ready",
			repository: { owner: "example", repo: "widget" },
			matches: [{ path: "src/index.ts", line: 4 }],
		});
		expect(text).toContain("Repository Fetch");
		expect(text).toContain("status: ready");
		expect(text).toContain("repository.owner: example");
		expect(text).toContain("matches (1)");
		expect(text).not.toContain('{"');
	});

	it("bounds collection entries, depth, and UTF-8 output bytes", () => {
		const text = formatSemanticModelContent("Candidates", { candidates: Array.from({ length: 100 }, (_, index) => ({ name: `candidate-${index}` })) }, 256);
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(256);
		expect(text).toContain("Candidates");
		expect(text).toContain("truncated");
	});
});
