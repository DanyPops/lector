import type { InstalledPythonVersionBounds, InstalledPythonVersionOutcome, InstalledPythonVersionRequest } from "./installed-package-version.ts";

export interface InstalledPythonVersionResolverPort {
	resolve(request: InstalledPythonVersionRequest, bounds: InstalledPythonVersionBounds): Promise<InstalledPythonVersionOutcome>;
}
