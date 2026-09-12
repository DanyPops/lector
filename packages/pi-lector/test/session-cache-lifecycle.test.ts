import { expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LectorClient, OperationName } from "@danypops/lector";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { materializePythonReferenceFixture } from "../../lector/test/support/python-reference-fixture.ts";
import { createLectorFindSymbolsOperations } from "../extension/src/find-symbols/operations.ts";
import lectorExtension from "../extension/src/index.ts";
import { resetLectorClientForTests, setLectorClientConnectorForTests, setNewWorkspaceObserver, workspaceForPath } from "../extension/src/lector-client.ts";
import { startIsolatedLectorDaemon } from "./support/isolated-lector-daemon.ts";

it("observer disposal preserves a replacement registration", async () => {
	const root = mkdtempSync(join(tmpdir(), "lector-observer-owner-"));
	const daemon = await startIsolatedLectorDaemon();
	const observed: string[] = [];
	const observer = (path: string) => {
		observed.push(path);
	};
	setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
	const disposeFirst = setNewWorkspaceObserver(observer);
	const disposeSecond = setNewWorkspaceObserver(observer);
	try {
		disposeFirst();
		mkdirSync(join(root, ".git"));
		await workspaceForPath(join(root, "a.ts"));
		expect(observed).toEqual([root]);
		disposeSecond();
		disposeSecond();
		const nested = join(root, "nested");
		mkdirSync(join(nested, ".git"), { recursive: true });
		await workspaceForPath(join(nested, "b.ts"));
		expect(observed).toEqual([root]);
	} finally {
		setNewWorkspaceObserver(undefined);
		await daemon.stop();
		resetLectorClientForTests();
		rmSync(root, { recursive: true, force: true });
	}
});

it("shutdown prevents cache monitoring on later workspace registration", async () => {
	const root = mkdtempSync(join(tmpdir(), "lector-session-cache-"));
	const daemon = await startIsolatedLectorDaemon();
	const calls: OperationName[] = [];
	const client: LectorClient = {
		...daemon.client,
		call: (operation, input) => {
			calls.push(operation);
			return daemon.client.call(operation, input);
		},
	};
	setLectorClientConnectorForTests(() => Promise.resolve(client));
	const harness = createExtensionHarness(lectorExtension, { cwd: root });
	try {
		await harness.boot();
		await harness.shutdown();
		setLectorClientConnectorForTests(() => Promise.resolve(client));
		calls.length = 0;
		mkdirSync(join(root, ".git"));
		writeFileSync(join(root, "a.ts"), "export const value = 1;\n");
		await workspaceForPath(join(root, "a.ts"));
		await workspaceForPath(join(root, "a.ts"));
		await workspaceForPath(join(root, "a.ts"));
		expect(calls).toEqual(["workspace.resolvePath"]);
	} finally {
		setNewWorkspaceObserver(undefined);
		await harness.shutdown();
		await daemon.stop();
		resetLectorClientForTests();
		rmSync(root, { recursive: true, force: true });
	}
}, 30_000);

it("Python lookup stays independent after shutdown", async () => {
	const fixture = materializePythonReferenceFixture();
	const daemon = await startIsolatedLectorDaemon();
	const calls: OperationName[] = [];
	const client: LectorClient = {
		...daemon.client,
		call: (operation, input) => {
			calls.push(operation);
			return daemon.client.call(operation, input);
		},
	};
	setLectorClientConnectorForTests(() => Promise.resolve(client));
	const harness = createExtensionHarness(lectorExtension, { cwd: fixture.root });
	try {
		await harness.boot();
		await harness.shutdown();
		setLectorClientConnectorForTests(() => Promise.resolve(client));
		calls.length = 0;
		const result = await createLectorFindSymbolsOperations().findSymbols("run_checkout", fixture.root);
		expect(result.symbols.some(({ name }) => name === "run_checkout")).toBe(true);
		expect(calls.filter((operation) => operation === "job.submit")).toEqual([]);
	} finally {
		setNewWorkspaceObserver(undefined);
		await harness.shutdown();
		await daemon.stop();
		resetLectorClientForTests();
		fixture.dispose();
	}
}, 30_000);
