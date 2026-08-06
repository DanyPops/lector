import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { LanguageServerDescriptor } from "../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { createLectorService, type LectorService } from "../src/service.ts";

const SERVER_PATH = fileURLToPath(new URL("support/file-operations-lsp-server.ts", import.meta.url));
const DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "typescript",
	backendId: "file-operations-fixture",
	extensions: [".ts"],
	launch: { kind: "system-binary", command: process.execPath },
	args: [SERVER_PATH],
	rootMarkers: ["tsconfig.json"],
	commonSeedCandidates: ["seed.ts"],
	settleMs: 0,
};
const WITHOUT_FILE_OPERATIONS: LanguageServerDescriptor = {
	...DESCRIPTOR,
	backendId: "no-file-operations-fixture",
	args: [SERVER_PATH, "--without-file-operations"],
};

interface FileOperationRecord {
	readonly method: string;
	readonly params: unknown;
}

let root: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (root) rmSync(root, { recursive: true, force: true });
	root = undefined;
});

function records(): FileOperationRecord[] {
	if (!root) return [];
	const path = join(root, ".file-operations.jsonl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as FileOperationRecord);
}

async function waitForRecords(count: number): Promise<FileOperationRecord[]> {
	const deadline = Date.now() + 2000;
	for (;;) {
		const current = records();
		if (current.length >= count || Date.now() >= deadline) return current;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

async function buildService(descriptor = DESCRIPTOR): Promise<{ workspaceId: string; seed: string; lectorService: LectorService }> {
	root = mkdtempSync(join(tmpdir(), "lector-service-file-operations-"));
	writeFileSync(join(root, "tsconfig.json"), "{}");
	const seed = join(root, "seed.ts");
	writeFileSync(seed, "export const seed = 1;\n");
	service = createLectorService(new Map(), {
		allowDynamicOnly: true,
		createSymbolIndex: (rootPath) => new LspSymbolIndex(rootPath, descriptor, "seed.ts"),
	});
	const { workspaceId } = await service.dispatch("workspace.registerPath", { path: root });
	await service.dispatch("workspace.documentSymbols", { workspaceId, path: seed });
	return { workspaceId, seed, lectorService: service };
}

describe("createLectorService LSP file-operation participation", () => {
	it("wraps real file creation and deletion with negotiated will/did requests and notifications", async () => {
		const { workspaceId, lectorService } = await buildService();
		const created = join(root as string, "created.ts");

		const outcome = await lectorService.dispatch("workspace.exactEdit", {
			workspaceId,
			path: created,
			expectedHash: null,
			content: "export const created = true;\n",
		});
		await lectorService.dispatch("workspace.deleteEntry", { workspaceId, path: created, expectedHash: outcome.newHash });

		const observed = await waitForRecords(4);
		expect(observed).toEqual([
			{ method: "workspace/willCreateFiles", params: { files: [{ uri: pathToFileURL(created).href }] } },
			{ method: "workspace/didCreateFiles", params: { files: [{ uri: pathToFileURL(created).href }] } },
			{ method: "workspace/willDeleteFiles", params: { files: [{ uri: pathToFileURL(created).href }] } },
			{ method: "workspace/didDeleteFiles", params: { files: [{ uri: pathToFileURL(created).href }] } },
		]);
	}, 10_000);

	it("notifies when reverting a deletion recreates the file", async () => {
		const { workspaceId, seed, lectorService } = await buildService();
		const { hash } = await lectorService.dispatch("workspace.rawRead", { workspaceId, path: seed });
		await lectorService.dispatch("workspace.deleteEntry", { workspaceId, path: seed, expectedHash: hash });
		const { entries } = await lectorService.dispatch("workspace.mutationHistory", { workspaceId, path: seed, maxResults: 10 });
		const deletion = entries.find((entry) => entry.operation === "delete");
		if (!deletion) throw new Error("deletion history entry was not recorded");

		await lectorService.dispatch("workspace.revertMutation", { workspaceId, entryId: deletion.id });

		const observed = await waitForRecords(4);
		expect(observed).toEqual([
			{ method: "workspace/willDeleteFiles", params: { files: [{ uri: pathToFileURL(seed).href }] } },
			{ method: "workspace/didDeleteFiles", params: { files: [{ uri: pathToFileURL(seed).href }] } },
			{ method: "workspace/willCreateFiles", params: { files: [{ uri: pathToFileURL(seed).href }] } },
			{ method: "workspace/didCreateFiles", params: { files: [{ uri: pathToFileURL(seed).href }] } },
		]);
	}, 10_000);

	it("does not emit file-operation messages when the server declares no capability", async () => {
		const { workspaceId, seed, lectorService } = await buildService(WITHOUT_FILE_OPERATIONS);
		const created = join(root as string, "created.ts");
		const outcome = await lectorService.dispatch("workspace.exactEdit", {
			workspaceId,
			path: created,
			expectedHash: null,
			content: "export const created = true;\n",
		});
		await lectorService.dispatch("workspace.deleteEntry", { workspaceId, path: created, expectedHash: outcome.newHash });
		await lectorService.dispatch("workspace.documentSymbols", { workspaceId, path: seed });

		expect(records()).toEqual([]);
	}, 10_000);

	it("never emits didCreate when guarded creation fails", async () => {
		const { workspaceId, seed, lectorService } = await buildService();

		await expect(
			lectorService.dispatch("workspace.exactEdit", {
				workspaceId,
				path: seed,
				expectedHash: null,
				content: "must not overwrite\n",
			}),
		).rejects.toThrow();

		const observed = await waitForRecords(1);
		expect(observed).toEqual([{ method: "workspace/willCreateFiles", params: { files: [{ uri: pathToFileURL(seed).href }] } }]);
	}, 10_000);
});
