import type { InstalledPackageVersionBounds, InstalledPackageVersionOutcome, InstalledPackageVersionRequest } from "../domain/installed-package-version.ts";

export interface InstalledPackageVersionResolverPort {
	resolve(request: InstalledPackageVersionRequest, bounds: InstalledPackageVersionBounds): Promise<InstalledPackageVersionOutcome>;
}
