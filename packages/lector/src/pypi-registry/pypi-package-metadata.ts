export interface PypiRegistryVersionRequest {
	readonly registry: string;
	readonly name: string;
	readonly version: string;
}

export interface PypiRegistryBounds {
	readonly maxResponseBytes: number;
	readonly maxRedirects: number;
	readonly maxRetries: number;
	readonly timeoutMs: number;
}

/** PyPI's own JSON API (`GET /pypi/<name>/<version>/json`) has no single canonical "repository" field the way npm's `repository` does -- `projectUrls` carries whatever labels the project itself chose (commonly "Source", "Repository", "Homepage", "Home"), resolved by normalize-pypi-repository.ts. */
export interface PypiPackageVersionMetadata {
	readonly name: string;
	readonly version: string;
	readonly projectUrls: Readonly<Record<string, string>> | null;
}
