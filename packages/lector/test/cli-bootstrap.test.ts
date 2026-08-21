import { describe, expect, it } from "bun:test";
import { formatCliBootstrapError } from "../src/cli-bootstrap.ts";

describe("Lector CLI bootstrap diagnostics", () => {
	it("turns a dependency missing-export SyntaxError into actionable single-source reinstall guidance", () => {
		const message = formatCliBootstrapError(new SyntaxError("Export named 'daemonInstanceIdentity' not found in module vehicle-client/daemon-client"));
		expect(message).toContain("incompatible dependency closure");
		expect(message).toContain("bun add --global @danypops/lector@latest");
		expect(message).toContain("lector service install");
		expect(message).not.toContain("SyntaxError");
	});

	it("keeps an ordinary startup failure concise without misclassifying it as dependency skew", () => {
		expect(formatCliBootstrapError(new Error("ordinary failure"))).toBe("Lector CLI failed to start: ordinary failure");
	});
});
