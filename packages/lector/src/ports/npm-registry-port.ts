import type { NpmPackageVersionMetadata, NpmRegistryBounds, NpmRegistryVersionRequest } from "../domain/npm-package-metadata.ts";

export interface NpmRegistryPort {
	fetchVersion(request: NpmRegistryVersionRequest, bounds: NpmRegistryBounds): Promise<NpmPackageVersionMetadata>;
}
