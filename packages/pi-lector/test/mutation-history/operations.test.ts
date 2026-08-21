/**
 * createMutationHistoryOperations wraps Lector's mutation history/revert, resolving its own
 * workspace per absolute path (workspaceForPath -- a plain filesystem concern, no language
 * server needed).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetLectorClientForTests } from "../../extension/src/lector-client.ts";
import { createMutationHistoryOperations } from "../../extension/src/mutation-history/operations.ts";
import { resetLectorVehicleClientForTests } from "../../extension/src/vehicle-client.ts";
import { wireVehicleDaemon } from "../support/wire-vehicle-daemon.ts";

let projectDir: string | undefined;
let stopDaemon: (() => Promise<void>) | undefined;

afterEach(async () => {
	resetLectorClientForTests();
	resetLectorVehicleClientForTests();
	await stopDaemon?.();
	stopDaemon = undefined;
	if (projectDir) rmSync(projectDir, { recursive: true, force: true });
	projectDir = undefined;
});

describe("Lector-backed mutation history operations", () => {
	it("lists and reverts a real edit via a running Lector daemon", async () => {
		const daemon = await wireVehicleDaemon();
		stopDaemon = daemon.stop;
		const root = mkdtempSync(join(tmpdir(), "pi-lector-mutation-history-"));
		mkdirSync(join(root, ".git")); // workspaceForPath's own project-root boundary is a real .git marker, not the filesystem root fallback.
		projectDir = root;
		const filePath = join(root, "a.txt");

		// registerPath/exactEdit/rawRead are not yet migrated onto VehicleRegistry -- still go
		// through the legacy LectorClient directly for setup/assertions.
		const { workspaceId } = await daemon.client.call("workspace.registerPath", { path: root });
		const first = await daemon.client.call("workspace.exactEdit", { workspaceId, path: "a.txt", expectedHash: null, content: "v1" });
		await daemon.client.call("workspace.exactEdit", { workspaceId, path: "a.txt", expectedHash: first.newHash, content: "v2" });

		const call = await daemon.call("mutation_history");
		const ops = createMutationHistoryOperations();
		const entries = await ops.list(filePath, 10, call);
		expect(entries).toHaveLength(2);

		const secondEntry = entries.find((entry) => entry.beforeContent === "v1");
		const reverted = await ops.revert(filePath, secondEntry?.id as string, call);

		expect(reverted).toEqual({ path: "a.txt", newHash: first.newHash });
		const read = await daemon.client.call("workspace.rawRead", { workspaceId, path: "a.txt" });
		expect(read.content).toBe("v1");
	}, 20_000);

	it("refuses a single-entry revert for one member of a real rename transaction, then reverts the whole transaction atomically", async () => {
		const daemon = await wireVehicleDaemon();
		stopDaemon = daemon.stop;
		const root = mkdtempSync(join(tmpdir(), "pi-lector-mutation-transaction-"));
		mkdirSync(join(root, ".git"));
		mkdirSync(join(root, "src"));
		writeFileSync(join(root, "src", "math.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
		writeFileSync(join(root, "src", "consumer.ts"), 'import { add } from "./math";\n\nexport function total(): number {\n\treturn add(1, 2);\n}\n');
		writeFileSync(
			join(root, "tsconfig.json"),
			JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
		);
		projectDir = root;
		const mathPath = join(root, "src", "math.ts");
		const consumerPath = join(root, "src", "consumer.ts");
		const { workspaceId } = await daemon.client.call("workspace.registerPath", { path: root });
		await daemon.client.call("workspace.documentSymbols", { workspaceId, path: consumerPath });
		const renamed = await daemon.client.call("workspace.rename", { workspaceId, path: mathPath, line: 1, character: 17, newName: "sum" });
		expect([...renamed.touchedPaths].sort()).toEqual([consumerPath, mathPath].sort());

		const call = await daemon.call("mutation_history");
		const ops = createMutationHistoryOperations();
		const entries = await ops.list(mathPath, 10, call);
		const entry = entries[0];
		if (!entry?.transactionId) throw new Error("expected a transaction-tagged rename entry");

		await expect(ops.revert(mathPath, entry.id, call)).rejects.toThrow("revert-transaction");
		expect(readFileSync(mathPath, "utf8")).toContain("function sum");
		expect(readFileSync(consumerPath, "utf8")).toContain("sum(1, 2)");

		const reverted = await ops.revertTransaction(mathPath, entry.transactionId, call);
		expect(reverted.reverted.map((item) => item.path).sort()).toEqual([consumerPath, mathPath].sort());
		expect(reverted.transactionId).not.toBe(entry.transactionId);
		expect(readFileSync(mathPath, "utf8")).toContain("function add");
		expect(readFileSync(consumerPath, "utf8")).toContain("add(1, 2)");
	}, 20_000);
});
