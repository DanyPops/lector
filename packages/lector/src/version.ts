import { readPackageVersion } from "@danypops/vehicle-server/version";
import { DAEMON_LABEL } from "./constants.ts";

export function lectorVersion(): string {
	return readPackageVersion(new URL("../package.json", import.meta.url), DAEMON_LABEL);
}
