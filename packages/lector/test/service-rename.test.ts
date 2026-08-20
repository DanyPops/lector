/**
 * Service-level wiring for workspace.prepareRename/workspace.rename against a real, live
 * typescript-language-server -- the LSP request/response shapes are each already covered
 * directly in lsp-symbol-index.test.ts; this proves the service glues capability checks, the
 * caller-supplied hash snapshot, the atomic apply, and will/did notification participation
 * together correctly end to end.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { createLectorService, type LectorService } from "../src/service.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-service-rename-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "math.ts"), "export function add(a: number, b: number): number {\n\treturn a + b;\n}\n");
	writeFileSync(join(root, "src", "consumer.ts"), 'import { add } from "./math";\n\nexport function sum(): number {\n\treturn add(1, 2);\n}\n');
	writeFileSync(
		join(root, "tsconfig.json"),
		JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true }, include: ["src"] }),
	);
	return root;
}

async function buildService(): Promise<{ service: LectorService; workspaceId: string }> {
	const service = createLectorService(new Map(), {
		allowDynamicOnly: true,
		createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
	});
	const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot as string });
	return { service, workspaceId };
}

describe("createLectorService's workspace.prepareRename/workspace.rename", () => {
	it("prepareRename reports a real declaration's own renameable range", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;

		const result = await service.dispatch("workspace.prepareRename", {
			workspaceId: built.workspaceId,
			path: join(fixtureRoot, "src", "math.ts"),
			line: 1,
			character: 17,
		});

		expect(result.range).not.toBeNull();
	}, 20_000);

	it("rename rewrites the declaration and its cross-file usage atomically", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;
		// Warms consumer.ts into the same server session so its usage is included in the edit.
		await service.dispatch("workspace.documentSymbols", { workspaceId: built.workspaceId, path: join(fixtureRoot, "src", "consumer.ts") });

		const outcome = await service.dispatch("workspace.rename", {
			workspaceId: built.workspaceId,
			path: join(fixtureRoot, "src", "math.ts"),
			line: 1,
			character: 17,
			newName: "sum",
		});

		expect([...outcome.touchedPaths].sort()).toEqual([join(fixtureRoot, "src", "consumer.ts"), join(fixtureRoot, "src", "math.ts")].sort());
		expect(readFileSync(join(fixtureRoot, "src", "math.ts"), "utf8")).toContain("export function sum");
		expect(readFileSync(join(fixtureRoot, "src", "consumer.ts"), "utf8")).toContain("sum(1, 2)");
	}, 20_000);

	it("prepareRename returns a null range, not an error, for a position with nothing renameable", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;
		writeFileSync(join(fixtureRoot, "src", "math.ts"), `${readFileSync(join(fixtureRoot, "src", "math.ts"), "utf8")}\n// a comment\n`);

		const result = await service.dispatch("workspace.prepareRename", {
			workspaceId: built.workspaceId,
			path: join(fixtureRoot, "src", "math.ts"),
			line: 5,
			character: 5,
		});

		expect(result.range).toBeNull();
	}, 20_000);

	it("rename against a snapshot taken after an unrelated concurrent edit still applies cleanly -- the snapshot reflects real current state, not a stale assumption", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;
		const mathPath = join(fixtureRoot, "src", "math.ts");

		// An unrelated file changes on disk before rename is even requested -- the service's own
		// snapshot (taken right before applying) must reflect this, not some earlier cached read.
		writeFileSync(join(fixtureRoot, "src", "consumer.ts"), 'import { add } from "./math";\n\nexport function total(): number {\n\treturn add(9, 9);\n}\n');

		const outcome = await service.dispatch("workspace.rename", {
			workspaceId: built.workspaceId,
			path: mathPath,
			line: 1,
			character: 17,
			newName: "sum",
		});

		expect(outcome.touchedPaths.length).toBeGreaterThan(0);
		expect(readFileSync(mathPath, "utf8")).toContain("export function sum");
		expect(readFileSync(join(fixtureRoot, "src", "consumer.ts"), "utf8")).toContain("sum(9, 9)");
	}, 20_000);

	it("records a rename's own per-file mutation-history entries correctly, tagged with a shared transactionId", async () => {
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;
		const mathPath = join(fixtureRoot, "src", "math.ts");
		const consumerPath = join(fixtureRoot, "src", "consumer.ts");
		await service.dispatch("workspace.documentSymbols", { workspaceId: built.workspaceId, path: consumerPath });

		await service.dispatch("workspace.rename", { workspaceId: built.workspaceId, path: mathPath, line: 1, character: 17, newName: "sum" });

		const mathHistory = await service.dispatch("workspace.mutationHistory", { workspaceId: built.workspaceId, path: mathPath, maxResults: 10 });
		const consumerHistory = await service.dispatch("workspace.mutationHistory", {
			workspaceId: built.workspaceId,
			path: consumerPath,
			maxResults: 10,
		});

		// The daemon backend tracks this correctly: both files get a real entry, operation "rename",
		// sharing one transactionId -- confirming the gap (see the next test) is NOT that renames go
		// untracked, but that the only revert the tool layer exposes ignores this grouping entirely.
		expect(mathHistory.entries).toHaveLength(1);
		expect(mathHistory.entries[0]).toMatchObject({ operation: "rename" });
		expect(consumerHistory.entries).toHaveLength(1);
		expect(consumerHistory.entries[0]).toMatchObject({ operation: "rename" });
		expect(mathHistory.entries[0]?.transactionId).toBe(consumerHistory.entries[0]?.transactionId);
		expect(mathHistory.entries[0]?.transactionId).not.toBeNull();
	}, 20_000);

	it("DANGER: workspace.revertMutation (the only revert pi-lector's mutation_history tool exposes) reverts one rename-transaction member in isolation, leaving the others broken", async () => {
		// This is the real gap: Lector's daemon has an atomic, all-or-nothing
		// workspace.revertMutationTransaction specifically to prevent this outcome -- but pi-lector's
		// mutation_history tool never wires it up (confirmed: zero references to
		// mutationTransaction/revertMutationTransaction anywhere in pi-lector's extension source).
		// The only revert action the tool exposes is single-entry workspace.revertMutation, which has
		// no idea a transaction even exists and happily reverts just one member.
		fixtureRoot = buildFixture();
		const built = await buildService();
		service = built.service;
		const mathPath = join(fixtureRoot, "src", "math.ts");
		const consumerPath = join(fixtureRoot, "src", "consumer.ts");
		await service.dispatch("workspace.documentSymbols", { workspaceId: built.workspaceId, path: consumerPath });
		await service.dispatch("workspace.rename", { workspaceId: built.workspaceId, path: mathPath, line: 1, character: 17, newName: "sum" });

		const mathHistory = await service.dispatch("workspace.mutationHistory", { workspaceId: built.workspaceId, path: mathPath, maxResults: 10 });
		const mathEntry = mathHistory.entries[0];
		if (!mathEntry) throw new Error("expected a recorded math.ts rename entry");

		// Reverts ONLY math.ts's own half of the transaction -- consumer.ts is never touched.
		await service.dispatch("workspace.revertMutation", { workspaceId: built.workspaceId, entryId: mathEntry.id });

		// The real, confirmed damage: math.ts is back to exporting "add", but consumer.ts still
		// imports and calls "sum" -- a name math.ts no longer exports. Silently broken code, with no
		// warning that this revert was only one member of an atomic multi-file rename.
		expect(readFileSync(mathPath, "utf8")).toContain("export function add");
		expect(readFileSync(mathPath, "utf8")).not.toContain("export function sum");
		expect(readFileSync(consumerPath, "utf8")).toContain('import { sum } from "./math"');
		expect(readFileSync(consumerPath, "utf8")).toContain("sum(1, 2)");
	}, 20_000);
});
