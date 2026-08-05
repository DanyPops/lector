export interface NpmRegistryVersionRequest {
	readonly registry: string;
	readonly name: string;
	readonly version: string;
}

export interface NpmRegistryBounds {
	readonly maxResponseBytes: number;
	readonly maxRedirects: number;
	readonly maxRetries: number;
	readonly timeoutMs: number;
}

export interface NpmRepositoryMetadata {
	readonly type: string | null;
	readonly url: string;
	readonly directory: string | null;
}

export interface NpmPackageVersionMetadata {
	readonly name: string;
	readonly version: string;
	readonly repository: NpmRepositoryMetadata | null;
	readonly gitHead: string | null;
	readonly integrity: string | null;
}
