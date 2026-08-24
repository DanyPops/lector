import { describe, expect, it } from "bun:test";
import { parseGoModulePath } from "../../src/go-module-registry/parse-go-module-path.ts";

describe("parseGoModulePath", () => {
	it("parses a plain github.com module path with no subdirectory", () => {
		expect(parseGoModulePath("github.com/prometheus/client_golang")).toEqual({
			host: "github.com",
			owner: "prometheus",
			repo: "client_golang",
			subdirectory: null,
		});
	});

	it("parses a github.com module path that lives in a repo subdirectory", () => {
		expect(parseGoModulePath("github.com/sourcegraph/zoekt/gitindex")).toEqual({
			host: "github.com",
			owner: "sourcegraph",
			repo: "zoekt",
			subdirectory: "gitindex",
		});
	});

	it("parses a multi-segment subdirectory", () => {
		expect(parseGoModulePath("github.com/example/monorepo/internal/tools/cli")).toEqual({
			host: "github.com",
			owner: "example",
			repo: "monorepo",
			subdirectory: "internal/tools/cli",
		});
	});

	it("recognizes gitlab.com and bitbucket.org as well-known hosts too", () => {
		expect(parseGoModulePath("gitlab.com/example/project")).toEqual({ host: "gitlab.com", owner: "example", repo: "project", subdirectory: null });
		expect(parseGoModulePath("bitbucket.org/example/project")).toEqual({ host: "bitbucket.org", owner: "example", repo: "project", subdirectory: null });
	});

	it("strips a module path's own major-version suffix (/v2, /v3, ...) from the repo segment", () => {
		expect(parseGoModulePath("github.com/example/project/v2")).toEqual({ host: "github.com", owner: "example", repo: "project", subdirectory: null });
	});

	it("returns null for a private/vanity host not in the well-known list", () => {
		expect(parseGoModulePath("git.internal.example/team/private-module")).toBeNull();
	});

	it("returns null for a module path with fewer than two path segments after the host", () => {
		expect(parseGoModulePath("github.com/onlyowner")).toBeNull();
	});
});
