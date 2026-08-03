import { dirname, join } from "node:path";
import type { DaemonPaths } from "@danypops/vehicle-server/paths";

/** The provisioning install root lives as a sibling of Lector's own database file -- under the same XDG data directory a daemon already owns, never a global system location. */
export function resolveLspProvisioningRoot(paths: DaemonPaths): string {
	return join(dirname(paths.database), "lsp-servers");
}
