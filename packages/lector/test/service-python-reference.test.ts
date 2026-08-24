import { afterEach, describe, expect, it } from "bun:test";
import { AuthenticatedRpcClient } from "@danypops/vehicle-client/rpc-client";
import { startDaemon } from "@danypops/vehicle-server/daemon";
import { ensureAuthToken } from "@danypops/vehicle-server/paths";
import { buildLectorApp } from "../src/daemon.ts";
import { createLectorService, type LectorService, type OperationInputs, type OperationName, type OperationOutputs } from "../src/service.ts";
import { findPositionOf } from "./support/find-position.ts";
import { isolatedLectorPaths } from "./support/isolated-daemon-paths.ts";
import { materializePythonReferenceFixture, type PythonReferenceFixture } from "./support/python-reference-fixture.ts";

let fixture: PythonReferenceFixture | undefined;
let service: LectorService | undefined;
let stop: (() => Promise<void>) | undefined;

afterEach(async () => {
	await stop?.();
	stop = undefined;
	await service?.close();
	service = undefined;
	fixture?.dispose();
	fixture = undefined;
});

describe("Python reference service and authenticated client", () => {
	it("preserves semantic provenance and filesystem hash conflicts over authenticated RPC", async () => {
		fixture = materializePythonReferenceFixture();
		service = createLectorService(new Map(), { allowDynamicOnly: true });
		const isolated = isolatedLectorPaths();
		const token = ensureAuthToken(isolated.paths.token, "Lector");
		const daemon = await startDaemon({
			daemonLabel: "Lector",
			handlePath: isolated.paths.handle,
			buildApp: () => buildLectorApp(service as LectorService, token),
		});
		stop = async () => {
			await daemon.stop();
			isolated.cleanup();
		};
		const client = new AuthenticatedRpcClient<OperationName, OperationInputs, OperationOutputs>(`http://${daemon.host}:${daemon.port}`, token, {
			label: "Lector",
		});
		const { workspaceId } = await client.call("workspace.registerPath", { path: fixture.root });
		await expect(client.call("workspace.findSymbols", { workspaceId, query: "x".repeat(4_097) })).rejects.toThrow("InvalidSymbolQuery");

		const symbols = await client.call("workspace.findSymbols", { workspaceId, query: "run_checkout", maxResults: 1 });
		expect(symbols.provenance).toMatchObject({ fidelity: "semantic", backend: "pyright", languageId: "python" });
		expect(symbols.symbols).toHaveLength(1);

		const checkoutPath = `${fixture.root}/app/checkout.py`;
		const usage = findPositionOf(checkoutPath, "processor.process(order)");
		const definition = await client.call("workspace.goToDefinition", {
			workspaceId,
			path: checkoutPath,
			line: usage.line,
			character: usage.character + "processor.".length,
		});
		expect(definition.provenance).toEqual(symbols.provenance);
		expect(definition.locations.some(({ path }) => path.endsWith("contracts/payment.py"))).toBe(true);

		const read = await client.call("workspace.rawRead", { workspaceId, path: "ignored/raw_text.py" });
		const edited = await client.call("workspace.exactEdit", {
			workspaceId,
			path: "ignored/raw_text.py",
			expectedHash: read.hash,
			content: `${read.content}\nclient_mutation = True\n`,
		});
		expect(edited.newHash).not.toBe(read.hash);
		await expect(
			client.call("workspace.exactEdit", {
				workspaceId,
				path: "ignored/raw_text.py",
				expectedHash: read.hash,
				content: read.content,
			}),
		).rejects.toThrow("StaleExpectedHash");
	}, 30_000);
});
