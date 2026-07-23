import { resolveDaemonPaths, type DaemonPathNames, type DaemonPaths, type PathEnvironment } from "@danypops/daemon-kit/paths";

export const DAEMON_LABEL = "Lector";

export const LECTOR_PATH_NAMES: DaemonPathNames = {
	stateDirectoryName: "lector",
	databaseFilename: "lector.db",
	tokenFilename: "token",
	handleFilename: "handle.json",
	systemdUnitName: "lector.service",
};

/** Resolve Lector's XDG-compliant paths. Tests inject `environment` to isolate against a tmp root. */
export function resolveLectorPaths(environment?: PathEnvironment): DaemonPaths {
	return resolveDaemonPaths(LECTOR_PATH_NAMES, environment);
}
