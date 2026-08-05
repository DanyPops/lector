import type { ExternalSearchBounds, NpmPackageCandidate } from "../external-search/external-search-result.ts";
import type { NpmPackageVersionMetadata, NpmRegistryBounds, NpmRegistryVersionRequest } from "./npm-package-metadata.ts";

export interface NpmRegistryPort {
	fetchVersion(request: NpmRegistryVersionRequest, bounds: NpmRegistryBounds): Promise<NpmPackageVersionMetadata>;
	search(query: string, bounds: ExternalSearchBounds): Promise<readonly NpmPackageCandidate[]>;
}
