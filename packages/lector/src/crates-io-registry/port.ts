import type { CratesIoPackageVersionMetadata, CratesIoRegistryBounds, CratesIoRegistryVersionRequest } from "./crates-io-package-metadata.ts";

export interface CratesIoRegistryPort {
	fetchVersion(request: CratesIoRegistryVersionRequest, bounds: CratesIoRegistryBounds): Promise<CratesIoPackageVersionMetadata>;
}
