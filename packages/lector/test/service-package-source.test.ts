import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PACKAGE_SOURCE_BOUNDS, type PackageSourceOutcome, type PackageSourceRequest } from "../src/package-source/package-source.ts";
import type { PackageSourceResolverPort } from "../src/package-source/resolver-port.ts";
import { createLectorService, type LectorService, PackageSourceResolverNotConfigured } from "../src/service.ts";
import { WorkspaceIsReadOnly } from "../src/workspace/read-only-workspace.ts";
import { recordingLogger } from "./support/recording-logger.ts";

let root: string | undefined;
let service: LectorService | undefined;

const REQUEST: PackageSourceRequest = {
	projectRoot: "/consumer",
	coordinate: { ecosystem: "npm", registry: "https://registry.example", name: "@scope/widget", requestedVersion: "1.2.3" },
};

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

class FixedResolver implements PackageSourceResolverPort {
	constructor(private readonly outcome: PackageSourceOutcome) {}

	resolve(): Promise<PackageSourceOutcome> {
		return Promise.resolve(this.outcome);
	}
}

function verified(cachePath: string): PackageSourceOutcome {
	return {
		status: "verified",
		coordinate: { ...REQUEST.coordinate, resolvedVersion: "1.2.3" },
		repository: {
			url: "https://github.com/acme/widgets.git",
			requestedRef: "1111111111111111111111111111111111111111",
			resolvedRef: "1111111111111111111111111111111111111111",
			commit: "1111111111111111111111111111111111111111",
		},
		workspace: { cachePath, origin: "fetched", readOnly: true },
		verification: { status: "verified", method: "registry-metadata-and-commit", integrity: "git:1111111111111111111111111111111111111111" },
	};
}

describe("createLectorService package.resolveSource", () => {
	it("requires an explicitly configured source resolver when repository fetching is absent", async () => {
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		await expect(service.dispatch("package.resolveSource", { request: REQUEST, bounds: DEFAULT_PACKAGE_SOURCE_BOUNDS })).rejects.toBeInstanceOf(
			PackageSourceResolverNotConfigured,
		);
	});

	it("registers a verified package directory as a reusable read-only workspace", async () => {
		root = mkdtempSync(join(tmpdir(), "lector-package-source-service-"));
		writeFileSync(join(root, "index.ts"), "export const widget = 1;\n");
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createPackageSourceResolver: () => new FixedResolver(verified(root as string)),
		});

		const result = await service.dispatch("package.resolveSource", { request: REQUEST, bounds: DEFAULT_PACKAGE_SOURCE_BOUNDS });

		expect(result.outcome.status).toBe("verified");
		expect(result.workspaceId).not.toBeNull();
		const read = await service.dispatch("workspace.rawRead", { workspaceId: result.workspaceId as string, path: "index.ts" });
		expect(read.content).toContain("widget");
		await expect(
			service.dispatch("workspace.exactEdit", {
				workspaceId: result.workspaceId as string,
				path: "index.ts",
				expectedHash: read.hash,
				content: "changed\n",
			}),
		).rejects.toBeInstanceOf(WorkspaceIsReadOnly);
	});

	it("does not invent a workspace id for an unavailable source and logs only its typed failure classification", async () => {
		const { logger, calls } = recordingLogger();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			logger,
			createPackageSourceResolver: () => new FixedResolver({ status: "unavailable", code: "source-metadata-missing" }),
		});

		const result = await service.dispatch("package.resolveSource", { request: REQUEST, bounds: DEFAULT_PACKAGE_SOURCE_BOUNDS });

		expect(result).toEqual({ outcome: { status: "unavailable", code: "source-metadata-missing" }, workspaceId: null });
		expect(calls).toContainEqual({
			level: "warn",
			message: "package source resolution failed",
			fields: { component: "package-source", operation: "package.resolveSource", status: "unavailable", code: "source-metadata-missing" },
		});
		expect(JSON.stringify(calls)).not.toContain(REQUEST.coordinate.registry);
		expect(JSON.stringify(calls)).not.toContain(REQUEST.projectRoot);
	});
});
