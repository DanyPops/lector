import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { RunningDaemon } from "@danypops/daemon-kit/daemon";
import { startLectorDaemon } from "../src/daemon.ts";
import type { SymbolSearchResult } from "../src/domain/workspace-symbol.ts";
import { findPositionOf } from "./support/find-position.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";
import { materializeTypeScriptReferenceFixture, type TypeScriptReferenceFixture } from "./support/typescript-reference-fixture.ts";

let daemon: RunningDaemon | undefined;
let isolated: ReturnType<typeof isolatedLectorPaths> | undefined;
let fixture: TypeScriptReferenceFixture | undefined;

afterEach(async () => {
	await daemon?.stop();
	daemon = undefined;
	isolated?.cleanup();
	isolated = undefined;
	fixture?.dispose();
	fixture = undefined;
});

async function runCli(args: readonly string[]): Promise<string> {
	if (!isolated) throw new Error("isolated daemon paths not initialized");
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
		env: {
			...process.env,
			XDG_DATA_HOME: isolated.root,
			XDG_STATE_HOME: isolated.root,
			XDG_RUNTIME_DIR: isolated.root,
			XDG_CONFIG_HOME: isolated.root,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	if (exitCode !== 0) throw new Error(`CLI exited ${exitCode}: ${stderr}`);
	return stdout.trim();
}

describe("TypeScript/JavaScript reference CLI parity", () => {
	it("preserves bounded semantic provenance in JSON and human output", async () => {
		isolated = isolatedLectorPaths();
		fixture = materializeTypeScriptReferenceFixture();
		daemon = startLectorDaemon({ workspaces: new Map(), allowDynamicOnly: true, paths: isolated.paths });
		const registration = JSON.parse(await runCli(["workspace", "register", fixture.root, "--json"])) as { workspaceId: string };

		const json = JSON.parse(await runCli(["workspace", "symbols", registration.workspaceId, "runCheckout", "--json"])) as SymbolSearchResult;
		expect(json.provenance).toMatchObject({ fidelity: "semantic", backend: "typescript-language-server", authority: "language-server" });
		expect(json.symbols.some(({ name }) => name === "runCheckout")).toBe(true);
		expect(typeof json.truncated).toBe("boolean");

		const checkoutPath = join(fixture.root, "packages/app/src/checkout.ts");
		const usage = findPositionOf(checkoutPath, "processor.process(order)");
		const definition = JSON.parse(
			await runCli([
				"workspace",
				"definition",
				registration.workspaceId,
				checkoutPath,
				String(usage.line),
				String(usage.character + "processor.".length),
				"--json",
			]),
		) as { provenance: SymbolSearchResult["provenance"]; locations: readonly { path: string }[] };
		expect(definition.provenance).toEqual(json.provenance);
		expect(definition.locations.some(({ path }) => path.endsWith("packages/contracts/src/payment.ts"))).toBe(true);

		const human = await runCli(["workspace", "symbols", registration.workspaceId, "runCheckout"]);
		expect(human).toContain("semantic via typescript-language-server");
		expect(human).toContain("runCheckout");
		expect(human.length).toBeLessThan(20_000);
	}, 30_000);
});
