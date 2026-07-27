import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PackageSourceBounds, PackageSourceOutcome, PackageSourceRequest, PackageSourceResolverPort } from "@danypops/lector";
import { resetLectorClientForTests, setLectorClientConnectorForTests } from "../extension/src/lector-client.ts";
import { createLectorPackageSourceOperations } from "../extension/src/package-source-operations.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

let stopDaemon: (() => Promise<void>) | undefined;
let sourceRoot: string | undefined;

class FixedResolver implements PackageSourceResolverPort {
	resolve(request: PackageSourceRequest, _bounds: PackageSourceBounds): Promise<PackageSourceOutcome> {
		return Promise.resolve({
			status: "verified",
			coordinate: { ...request.coordinate, resolvedVersion: "1.2.3" },
			repository: {
				url: "https://github.com/acme/widgets.git",
				requestedRef: "1111111111111111111111111111111111111111",
				resolvedRef: "1111111111111111111111111111111111111111",
				commit: "1111111111111111111111111111111111111111",
			},
			workspace: { cachePath: sourceRoot as string, origin: "fetched", readOnly: true },
			verification: { status: "verified", method: "registry-metadata-and-commit", integrity: "git:1111111111111111111111111111111111111111" },
		});
	}
}

afterEach(async () => {
	resetLectorClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (sourceRoot) rmSync(sourceRoot, { recursive: true, force: true });
	sourceRoot = undefined;
});

describe("Lector-backed package source operation", () => {
	it("resolves through the authenticated daemon and returns a registered read-only workspace", async () => {
		sourceRoot = mkdtempSync(join(tmpdir(), "pi-lector-package-source-"));
		writeFileSync(join(sourceRoot, "index.ts"), "export const widget = 1;\n");
		const daemon = await startIsolatedLectorDaemon({ createPackageSourceResolver: () => new FixedResolver() });
		stopDaemon = daemon.stop;
		setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));

		const result = await createLectorPackageSourceOperations().resolve("/consumer", "@scope/widget", "1.2.3", null);

		expect(result.outcome.status).toBe("verified");
		expect(result.workspaceId).not.toBeNull();
		const read = await daemon.client.call("workspace.rawRead", { workspaceId: result.workspaceId as string, path: "index.ts" });
		expect(read.content).toContain("widget");
	});
});
