import { describe, expect, it } from "bun:test";
import { escapeGoModulePath } from "../../src/go-module-registry/escape-go-module-path.ts";

describe("escapeGoModulePath", () => {
	it("leaves an all-lowercase module path unchanged", () => {
		expect(escapeGoModulePath("github.com/prometheus/client_golang")).toBe("github.com/prometheus/client_golang");
	});

	it("escapes each uppercase letter as ! followed by its lowercase form, per GOPROXY's own module-path escaping", () => {
		expect(escapeGoModulePath("rsc.io/Quote")).toBe("rsc.io/!quote");
	});

	it("escapes multiple uppercase letters within one path segment", () => {
		expect(escapeGoModulePath("github.com/BurntSushi/toml")).toBe("github.com/!burnt!sushi/toml");
	});
});
