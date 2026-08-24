import { describe, expect, it } from "bun:test";
import { normalizePythonPackageName } from "../../src/python-package-version-resolver/pep503.ts";

describe("normalizePythonPackageName", () => {
	it("lowercases the name", () => {
		expect(normalizePythonPackageName("Requests")).toBe("requests");
	});

	it("collapses runs of -, _, and . into a single hyphen (PEP 503)", () => {
		expect(normalizePythonPackageName("Friendly_Bard")).toBe("friendly-bard");
		expect(normalizePythonPackageName("friendly.bard")).toBe("friendly-bard");
		expect(normalizePythonPackageName("friendly--bard")).toBe("friendly-bard");
		expect(normalizePythonPackageName("friendly-.-bard")).toBe("friendly-bard");
	});

	it("treats already-normalized names as a no-op", () => {
		expect(normalizePythonPackageName("editable-dep")).toBe("editable-dep");
	});
});
