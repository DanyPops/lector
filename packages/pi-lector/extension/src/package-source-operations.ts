import { DEFAULT_PACKAGE_SOURCE_BOUNDS, type PackageSourceOperationResult } from "@danypops/lector";
import { lectorClient } from "./lector-client.ts";

export interface PackageSourceOperations {
	resolve(directory: string, name: string, requestedVersion: string | null, registry: string | null): Promise<PackageSourceOperationResult>;
}

export function createLectorPackageSourceOperations(): PackageSourceOperations {
	return {
		async resolve(directory, name, requestedVersion, registry) {
			const client = await lectorClient();
			return client.call("package.resolveSource", {
				request: {
					projectRoot: directory,
					coordinate: { ecosystem: "npm", registry, name, requestedVersion },
				},
				bounds: DEFAULT_PACKAGE_SOURCE_BOUNDS,
			});
		},
	};
}
