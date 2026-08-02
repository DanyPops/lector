import type { PackageSourceBounds, PackageSourceOutcome, PackageSourceRequest } from "./package-source.ts";

export interface PackageSourceResolverPort {
	resolve(request: PackageSourceRequest, bounds: PackageSourceBounds): Promise<PackageSourceOutcome>;
}
