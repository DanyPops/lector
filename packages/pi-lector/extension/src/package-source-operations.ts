import { DEFAULT_PACKAGE_SOURCE_BOUNDS, type PackageEcosystem, type PackageSourceListEntry, type PackageSourceOperationResult } from "@danypops/lector";
import { lectorClient } from "./lector-client.ts";

export interface PackageSourceListPage {
	readonly entries: readonly PackageSourceListEntry[];
	readonly nextCursor: string | null;
}

export interface PackageSourceOperations {
	resolve(directory: string, name: string, requestedVersion: string | null, registry: string | null): Promise<PackageSourceOperationResult>;
	list(options: { ecosystem?: PackageEcosystem; text?: string; maxResults: number; cursor?: string }): Promise<PackageSourceListPage>;
	remove(ecosystem: PackageEcosystem, registry: string | null, name: string, resolvedVersion: string): Promise<{ removed: boolean }>;
	clean(ecosystem: PackageEcosystem | undefined): Promise<{ removed: number; skipped: number }>;
}

export function createLectorPackageSourceOperations(): PackageSourceOperations {
	return {
		async resolve(directory, name, requestedVersion, registry) {
			const client = await lectorClient();
			return client.callOnce("package.resolveSource", {
				request: {
					projectRoot: directory,
					coordinate: { ecosystem: "npm", registry, name, requestedVersion },
				},
				bounds: DEFAULT_PACKAGE_SOURCE_BOUNDS,
			});
		},
		async list(options) {
			const client = await lectorClient();
			return client.call("package.listSources", options);
		},
		async remove(ecosystem, registry, name, resolvedVersion) {
			const client = await lectorClient();
			return client.callOnce("package.removeSource", { ecosystem, registry, name, resolvedVersion });
		},
		async clean(ecosystem) {
			const client = await lectorClient();
			return client.callOnce("package.cleanSources", { ecosystem });
		},
	};
}
