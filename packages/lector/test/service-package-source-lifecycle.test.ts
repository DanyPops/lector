import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryPackageSourceIndex } from "../src/adapters/in-memory-package-source-index.ts";
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { DEFAULT_PACKAGE_SOURCE_BOUNDS, type PackageSourceOutcome, type PackageSourceRequest } from "../src/domain/package-source.ts";
import type { PackageSourceIndexEntry } from "../src/domain/package-source-index.ts";
import type { PackageSourceResolverPort } from "../src/ports/package-source-resolver-port.ts";
import { createLectorService, type LectorService, PackageSourceEntryInUse, PackageSourceResolverNotConfigured } from "../src/service.ts";

let roots: string[] = [];
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	for (const root of roots) rmSync(root, { recursive: true, force: true });
	roots = [];
});

class FixedResolver implements PackageSourceResolverPort {
	constructor(private readonly outcomesByName: ReadonlyMap<string, PackageSourceOutcome>) {}

	resolve(request: PackageSourceRequest): Promise<PackageSourceOutcome> {
		const outcome = this.outcomesByName.get(request.coordinate.name);
		if (!outcome) throw new Error(`no fixture outcome for ${request.coordinate.name}`);
		return Promise.resolve(outcome);
	}
}

function newRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-package-source-lifecycle-"));
	writeFileSync(join(root, "index.ts"), "export const value = 1;\n");
	roots.push(root);
	return root;
}

function verified(name: string, resolvedVersion: string, cachePath: string): PackageSourceOutcome {
	return {
		status: "verified",
		coordinate: { ecosystem: "npm", registry: null, name, requestedVersion: null, resolvedVersion },
		repository: {
			url: `https://github.com/acme/${name}.git`,
			requestedRef: "1111111111111111111111111111111111111111",
			resolvedRef: "1111111111111111111111111111111111111111",
			commit: "1111111111111111111111111111111111111111",
		},
		workspace: { cachePath, origin: "fetched", readOnly: true },
		verification: { status: "verified", method: "registry-metadata-and-commit", integrity: "git:1111111111111111111111111111111111111111" },
	};
}

function requestFor(name: string): PackageSourceRequest {
	return { projectRoot: "/consumer", coordinate: { ecosystem: "npm", registry: null, name, requestedVersion: null } };
}

function indexEntry(overrides: Partial<PackageSourceIndexEntry> = {}): PackageSourceIndexEntry {
	return {
		ecosystem: "npm",
		registry: null,
		name: "zod",
		resolvedVersion: "3.22.0",
		requestedVersion: null,
		repositoryUrl: "https://github.com/acme/zod.git",
		resolvedRef: "1111111111111111111111111111111111111111",
		commit: "1111111111111111111111111111111111111111",
		cachePath: "/nonexistent/zod",
		workspaceId: "workspace-not-registered",
		origin: "fetched",
		verificationMethod: "registry-metadata-and-commit",
		resolvedAt: Date.now(),
		...overrides,
	};
}

describe("createLectorService package-source lifecycle", () => {
	it("requires an explicitly configured source resolver for list/remove/clean, same as resolveSource", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("package.listSources", { maxResults: 10 })).rejects.toBeInstanceOf(PackageSourceResolverNotConfigured);
		await expect(service.dispatch("package.removeSource", { ecosystem: "npm", registry: null, name: "zod", resolvedVersion: "1.0.0" })).rejects.toBeInstanceOf(
			PackageSourceResolverNotConfigured,
		);
		await expect(service.dispatch("package.cleanSources", {})).rejects.toBeInstanceOf(PackageSourceResolverNotConfigured);
	});

	it("lists nothing before any package source has ever been resolved", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true, createPackageSourceResolver: () => new FixedResolver(new Map()) });
		const page = await service.dispatch("package.listSources", { maxResults: 10 });
		expect(page.entries).toEqual([]);
		expect(page.nextCursor).toBeNull();
	});

	it("records a verified resolveSource outcome, then surfaces it via listSources", async () => {
		const root = newRoot();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createPackageSourceResolver: () => new FixedResolver(new Map([["zod", verified("zod", "3.22.0", root)]])),
		});

		await service.dispatch("package.resolveSource", { request: requestFor("zod"), bounds: DEFAULT_PACKAGE_SOURCE_BOUNDS });
		const page = await service.dispatch("package.listSources", { maxResults: 10 });

		expect(page.entries).toHaveLength(1);
		expect(page.entries[0]?.name).toBe("zod");
		expect(page.entries[0]?.resolvedVersion).toBe("3.22.0");
		expect(page.entries[0]?.cachePath).toBe(root);
	});

	it("does not record an index entry for an unavailable outcome", async () => {
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createPackageSourceResolver: () => new FixedResolver(new Map([["zod", { status: "unavailable", code: "package-not-found" }]])),
		});

		await service.dispatch("package.resolveSource", { request: requestFor("zod"), bounds: DEFAULT_PACKAGE_SOURCE_BOUNDS });
		const page = await service.dispatch("package.listSources", { maxResults: 10 });
		expect(page.entries).toEqual([]);
	});

	it("filters listSources by ecosystem", async () => {
		const root = newRoot();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createPackageSourceResolver: () => new FixedResolver(new Map([["zod", verified("zod", "3.22.0", root)]])),
		});
		await service.dispatch("package.resolveSource", { request: requestFor("zod"), bounds: DEFAULT_PACKAGE_SOURCE_BOUNDS });

		const npmPage = await service.dispatch("package.listSources", { maxResults: 10, ecosystem: "npm" });
		expect(npmPage.entries).toHaveLength(1);
		const pypiPage = await service.dispatch("package.listSources", { maxResults: 10, ecosystem: "pypi" });
		expect(pypiPage.entries).toEqual([]);
	});

	it("removes a recorded entry whose backing workspace is not currently registered", async () => {
		const index = new InMemoryPackageSourceIndex();
		await index.record(indexEntry());
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createPackageSourceResolver: () => new FixedResolver(new Map()),
			createPackageSourceIndex: () => index,
		});

		const result = await service.dispatch("package.removeSource", { ecosystem: "npm", registry: null, name: "zod", resolvedVersion: "3.22.0" });

		expect(result.removed).toBe(true);
		const page = await service.dispatch("package.listSources", { maxResults: 10 });
		expect(page.entries).toEqual([]);
	});

	it("refuses removal while the resolved source is still a registered workspace, leaving the index untouched", async () => {
		const root = newRoot();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createPackageSourceResolver: () => new FixedResolver(new Map([["zod", verified("zod", "3.22.0", root)]])),
		});
		await service.dispatch("package.resolveSource", { request: requestFor("zod"), bounds: DEFAULT_PACKAGE_SOURCE_BOUNDS });

		await expect(service.dispatch("package.removeSource", { ecosystem: "npm", registry: null, name: "zod", resolvedVersion: "3.22.0" })).rejects.toBeInstanceOf(
			PackageSourceEntryInUse,
		);
		const page = await service.dispatch("package.listSources", { maxResults: 10 });
		expect(page.entries).toHaveLength(1);
	});

	it("returns removed:false, not an error, for a key that was never recorded", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true, createPackageSourceResolver: () => new FixedResolver(new Map()) });
		const result = await service.dispatch("package.removeSource", { ecosystem: "npm", registry: null, name: "never-recorded", resolvedVersion: "1.0.0" });
		expect(result.removed).toBe(false);
	});

	it("cleanSources removes every non-in-use entry and skips in-use ones, reporting counts for both", async () => {
		const index = new InMemoryPackageSourceIndex();
		await index.record(indexEntry({ name: "free", workspaceId: "workspace-free" }));
		await index.record(indexEntry({ name: "busy", workspaceId: "workspace-busy" }));
		const registry = new Map([["workspace-busy", new InMemoryWorkspace()]]);
		service = createLectorService(registry, {
			allowDynamicOnly: true,
			createPackageSourceResolver: () => new FixedResolver(new Map()),
			createPackageSourceIndex: () => index,
		});

		const result = await service.dispatch("package.cleanSources", {});

		expect(result.removed).toBe(1);
		expect(result.skipped).toBe(1);
		const page = await service.dispatch("package.listSources", { maxResults: 10 });
		expect(page.entries.map((entry) => entry.name)).toEqual(["busy"]);
	});

	it("cleanSources scopes to one ecosystem when given", async () => {
		const index = new InMemoryPackageSourceIndex();
		await index.record(indexEntry({ ecosystem: "npm", name: "npm-pkg", workspaceId: "workspace-npm" }));
		await index.record(indexEntry({ ecosystem: "pypi", name: "pypi-pkg", resolvedVersion: "1.0.0", workspaceId: "workspace-pypi" }));
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createPackageSourceResolver: () => new FixedResolver(new Map()),
			createPackageSourceIndex: () => index,
		});

		const result = await service.dispatch("package.cleanSources", { ecosystem: "npm" });

		expect(result.removed).toBe(1);
		expect(result.skipped).toBe(0);
		const page = await service.dispatch("package.listSources", { maxResults: 10 });
		expect(page.entries.map((entry) => entry.name)).toEqual(["pypi-pkg"]);
	});
});
