import type { PackageSourceBounds, PackageSourceOutcome, PackageSourceRequest } from "../domain/package-source.ts";

export interface PackageSourceResolverPort {
	resolve(request: PackageSourceRequest, bounds: PackageSourceBounds): Promise<PackageSourceOutcome>;
}
