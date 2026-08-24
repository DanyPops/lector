import type { PypiPackageVersionMetadata, PypiRegistryBounds, PypiRegistryVersionRequest } from "./pypi-package-metadata.ts";

export interface PypiRegistryPort {
	fetchVersion(request: PypiRegistryVersionRequest, bounds: PypiRegistryBounds): Promise<PypiPackageVersionMetadata>;
}
