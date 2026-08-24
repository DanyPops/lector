import type { InstalledCrateVersionBounds, InstalledCrateVersionOutcome, InstalledCrateVersionRequest } from "./installed-crate.ts";

export interface InstalledCrateVersionResolverPort {
	resolve(request: InstalledCrateVersionRequest, bounds: InstalledCrateVersionBounds): Promise<InstalledCrateVersionOutcome>;
}
