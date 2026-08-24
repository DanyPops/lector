export interface CratesIoPackageVersionMetadata {
	readonly name: string;
	readonly version: string;
	/** True when this exact version has been yanked from the registry -- crates.io still serves a yanked version's own metadata and tarball; yanking only blocks a *fresh* dependency resolution from picking it, never removes an already-locked build's ability to fetch it. Surfaced for provenance, never treated as a resolution failure on its own. */
	readonly yanked: boolean;
	readonly repository: string | null;
}

export interface CratesIoRegistryVersionRequest {
	readonly registryUrl: string;
	/** null for the default crates.io registry, which needs no authentication for a read. An alternate/private registry's own name, used to look up its own distinctly-named `CARGO_REGISTRIES_<NAME>_TOKEN` credential. */
	readonly registryName: string | null;
	readonly name: string;
	readonly version: string;
}

export interface CratesIoRegistryBounds {
	readonly maxResponseBytes: number;
	readonly maxRedirects: number;
	readonly maxRetries: number;
	readonly timeoutMs: number;
}
