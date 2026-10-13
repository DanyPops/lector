import { extname } from "node:path";
import { documentSymbols } from "../../code-intelligence/document-symbols.ts";
import { findReferences } from "../../code-intelligence/find-references.ts";
import { findImportSpecifiers } from "../../code-intelligence/tree-sitter/import-specifiers.ts";
import { contentHashOf } from "../../content-identity/content-hash.ts";
import { planReferenceBasedRename, type ReferenceBasedRenamePlan } from "../../reference-based-rename/reference-based-rename.ts";
import { WorkspaceEntryNotFound } from "../../workspace/raw-read.ts";
import { MAX_POPULATE_RETRY_BUDGET_MS } from "../bounds.ts";
import { requireCodeIntelligence } from "../code-intelligence-handlers.ts";
import { ReferenceBasedRenameRequiresFreshGraph, SymbolQueryUnavailable, UnknownWorkspace } from "../errors.ts";
import type { OperationInputs } from "../operations.ts";
import type { MutableRegistry } from "../workspace-registry.ts";
import type { RenameHandlerDeps } from "./rename-handlers.ts";

export async function referenceRenamePlan(
	deps: Pick<RenameHandlerDeps, "registry" | "warmIndexes" | "cacheStatus" | "populateSymbolGraph" | "cacheWalkedFiles">,
	registry: MutableRegistry,
	input: OperationInputs["workspace.referenceBasedRename"],
): Promise<ReferenceBasedRenamePlan> {
	const entry = deps.registry.get(input.workspaceId);
	if (!entry) throw new UnknownWorkspace(input.workspaceId);
	if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
	let status = await deps.cacheStatus(registry, input);
	if (input.autoPopulate && status.status === "not-cached") {
		await deps.populateSymbolGraph(registry, {
			workspaceId: input.workspaceId,
			maxFiles: input.maxFiles,
			maxSymbolsPerFile: input.maxSymbolsPerFile,
			retryTimeBudgetMs: MAX_POPULATE_RETRY_BUDGET_MS,
		});
		status = await deps.cacheStatus(registry, input);
	}
	if (status.status !== "cached") throw new ReferenceBasedRenameRequiresFreshGraph(input.workspaceId, status.status);
	if (status.generation.result.sourceCoverage?.truncated) throw new ReferenceBasedRenameRequiresFreshGraph(input.workspaceId, "partial");
	const fromPath = entry.port.resolvePath(input.fromPath);
	const toPath = entry.port.resolvePath(input.toPath);
	await using lease = await requireCodeIntelligence(deps.warmIndexes, { workspaceId: input.workspaceId, path: fromPath });
	const symbols = await documentSymbols(lease.value.index, fromPath);
	const referencingPaths = new Set<string>();
	let offset = 0;
	for (;;) {
		const page = await deps.cacheWalkedFiles(registry, { workspaceId: input.workspaceId, offset, maxResults: 500, maxBytes: 65536 });
		for (const file of page.files) {
			const path = entry.port.resolvePath(file);
			if (path !== fromPath && [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(extname(path))) referencingPaths.add(path);
		}
		if (!page.truncated) break;
		if (page.nextOffset <= offset || page.nextOffset > input.maxFiles) throw new ReferenceBasedRenameRequiresFreshGraph(input.workspaceId, "partial");
		offset = page.nextOffset;
	}
	for (const symbol of symbols) {
		const position = { path: fromPath, ...symbol.selectionRange.start };
		for (const location of await findReferences(lease.value.index, position, false)) {
			const path = entry.port.resolvePath(location.path);
			if (path !== fromPath) referencingPaths.add(path);
		}
	}
	const referencingFiles = [];
	for (const path of referencingPaths) {
		const read = await entry.port.readEntry(path);
		if (read.exists)
			referencingFiles.push({
				path,
				content: read.content,
				hash: contentHashOf(read.content),
				importSpecifiers: await findImportSpecifiers(read.content, extname(path)),
			});
	}
	const moved = await entry.port.readEntry(fromPath);
	if (!moved.exists) throw new WorkspaceEntryNotFound(fromPath);
	return planReferenceBasedRename({
		fromPath,
		toPath,
		movedFileContent: moved.content,
		movedFileHash: contentHashOf(moved.content),
		movedFileImportSpecifiers: await findImportSpecifiers(moved.content, extname(fromPath)),
		referencingFiles,
	});
}
