import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { InstallReceipt } from "../domain/install-receipt.ts";
import { parseInstallReceipt, serializeInstallReceipt } from "../domain/install-receipt.ts";
import type { InstallLocation } from "./install-location.ts";

/** Reads a package's receipt if one exists and is well-formed; undefined for "never installed" or a corrupted/foreign file -- either way, provisioning treats it as needing a fresh install rather than crashing. */
export function tryReadReceipt(location: InstallLocation, packageId: string): InstallReceipt | undefined {
	const path = location.receiptPath(packageId);
	if (!existsSync(path)) return undefined;
	try {
		return parseInstallReceipt(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return undefined;
	}
}

export function writeReceipt(location: InstallLocation, receipt: InstallReceipt): void {
	const path = location.receiptPath(receipt.packageId);
	mkdirSync(location.packageDir(receipt.packageId), { recursive: true });
	writeFileSync(path, serializeInstallReceipt(receipt));
}
