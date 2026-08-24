import type { InstalledGoModuleVersionBounds, InstalledGoModuleVersionOutcome, InstalledGoModuleVersionRequest } from "./installed-go-module.ts";

export interface InstalledGoModuleVersionResolverPort {
	resolve(request: InstalledGoModuleVersionRequest, bounds: InstalledGoModuleVersionBounds): Promise<InstalledGoModuleVersionOutcome>;
}
