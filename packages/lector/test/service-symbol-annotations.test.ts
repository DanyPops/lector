/**
 * Service-level wiring for the annotation operations: create resolves real
 * anchor positions against a real graph and workspace, get/list live-check
 * staleness (option A) and persist a correction before returning, and
 * refresh/scrub/restore round-trip through the store. Domain-level
 * correctness of the staleness decision itself is already covered directly
 * in test/symbol-annotation/symbol-annotation-staleness.test.ts and
 * test/symbol-annotation/check-annotation-staleness.test.ts; this file only proves the
 * service dispatch, anchor resolution, and per-workspace store lifecycle
 * are wired correctly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LspSymbolIndex } from "../src/code-intelligence/lsp/lsp-symbol-index.ts";
import {
	AnnotationContainmentCycle,
	AnnotationRequiresAnchors,
	AutoPopulateRequiresBounds,
	createLectorService,
	type LectorService,
	UnknownAnnotationAnchor,
	UnknownAnnotationForContainment,
	type WorkspaceId,
} from "../src/service.ts";
import { InMemorySymbolGraph } from "../src/symbol-graph/in-memory-symbol-graph.ts";
import { deriveSymbolNodeId } from "../src/symbol-graph/symbol-node-id.ts";

let fixtureRoot: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
	fixtureRoot = undefined;
});

function buildFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-service-annotations-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "a.ts"), "export function add() {}\n");
	return root;
}

/** Captures the InMemorySymbolGraph the service creates for each workspace, so a test can seed real nodes into it directly -- populateSymbolGraph's own real-LSP walk is already covered elsewhere. */
function createServiceWithCapturedGraphs(): { service: LectorService; graphs: Map<WorkspaceId, InMemorySymbolGraph> } {
	const graphs = new Map<WorkspaceId, InMemorySymbolGraph>();
	const created = createLectorService(new Map(), {
		allowDynamicOnly: true,
		createSymbolGraph: (workspaceId) => {
			const graph = new InMemorySymbolGraph();
			graphs.set(workspaceId, graph);
			return graph;
		},
	});
	return { service: created, graphs };
}

/** The per-workspace graph is created lazily on first real use -- force that now so the test can seed a node into it directly, without a real LSP-backed populateSymbolGraph pass. */
async function warmGraph(service: LectorService, workspaceId: WorkspaceId, path: string): Promise<void> {
	await service.dispatch("workspace.symbolEdgesFrom", { workspaceId, path, line: 1, character: 1 });
}

function buildTypeScriptFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "lector-service-annotations-autopopulate-"));
	mkdirSync(join(root, "src"));
	writeFileSync(join(root, "src", "a.ts"), "export function add() {}\n");
	writeFileSync(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "ESNext", moduleResolution: "bundler", strict: true } }));
	return root;
}

describe("createLectorService's annotation operations", () => {
	it("creates an annotation anchored to a real symbol, and get() returns it fresh", async () => {
		fixtureRoot = buildFixture();
		const { service: svc, graphs } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");
		await warmGraph(service, workspaceId, path);
		graphs
			.get(workspaceId)
			?.addNode({ id: deriveSymbolNodeId({ path, line: 1, character: 1 }), name: "add", kind: "function", location: { path, line: 1, character: 1 } });

		const { annotation } = await service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "user-story-dataflow",
			title: "checkout flow",
			body: "narrative",
			anchors: [{ path, line: 1, character: 1 }],
		});
		expect(annotation.status).toBe("fresh");

		const { annotation: fetched } = await service.dispatch("workspace.getAnnotation", { workspaceId, id: annotation.id });
		expect(fetched?.status).toBe("fresh");
	});

	it("createAnnotation: autoPopulate: true populates once and then resolves a real anchor, with no manual populateSymbolGraph call", async () => {
		fixtureRoot = buildTypeScriptFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");

		const { annotation } = await service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "note",
			title: "auto-populated anchor",
			body: "created against a workspace that had never been populated at all",
			anchors: [{ path, line: 1, character: 17 }],
			autoPopulate: true,
			maxFiles: 100,
			maxSymbolsPerFile: 50,
		});

		expect(annotation.anchors[0]?.path).toBe(path);
	}, 20_000);

	it("refreshAnnotation auto-populates once when a new anchor falls outside the completed generation", async () => {
		fixtureRoot = buildTypeScriptFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const originalPath = join(fixtureRoot, "src", "a.ts");
		const { annotation } = await service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "note",
			title: "original anchor",
			body: "created after the first bounded population",
			anchors: [{ path: originalPath, line: 1, character: 17 }],
			autoPopulate: true,
			maxFiles: 100,
			maxSymbolsPerFile: 50,
		});

		const addedPath = join(fixtureRoot, "src", "added.ts");
		writeFileSync(addedPath, "export function added() {}\n");
		const { annotation: refreshed } = await service.dispatch("workspace.refreshAnnotation", {
			workspaceId,
			id: annotation.id,
			subtype: "note",
			title: "new anchor",
			body: "refreshed after bounded on-demand population",
			anchors: [{ path: addedPath, line: 1, character: 17 }],
			autoPopulate: true,
			maxFiles: 100,
			maxSymbolsPerFile: 50,
		});

		expect(refreshed?.anchors[0]?.path).toBe(addedPath);
	}, 30_000);

	it("createAnnotation: without autoPopulate still throws UnknownAnnotationAnchor against a never-populated workspace -- opt-in stays opt-in", async () => {
		fixtureRoot = buildTypeScriptFixture();
		service = createLectorService(new Map(), {
			allowDynamicOnly: true,
			createSymbolIndex: (rootPath, descriptor, seedFile) => new LspSymbolIndex(rootPath, descriptor, seedFile),
		});
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");

		const attempt = service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "note",
			title: "should fail",
			body: "autoPopulate defaults off",
			anchors: [{ path, line: 1, character: 17 }],
		});

		await expect(attempt).rejects.toBeInstanceOf(UnknownAnnotationAnchor);
	}, 20_000);

	it("createAnnotation: autoPopulate: true without bounds throws AutoPopulateRequiresBounds rather than guessing a default scope", async () => {
		fixtureRoot = buildFixture();
		const { service: svc } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");

		const attempt = service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "note",
			title: "should fail",
			body: "no bounds given",
			anchors: [{ path, line: 1, character: 1 }],
			autoPopulate: true,
		});

		await expect(attempt).rejects.toBeInstanceOf(AutoPopulateRequiresBounds);
	});

	it("resolves a workspace-relative anchor path to the same symbol a caller would reach with the absolute form", async () => {
		fixtureRoot = buildFixture();
		const { service: svc, graphs } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const absolutePath = join(fixtureRoot, "src", "a.ts");
		await warmGraph(service, workspaceId, absolutePath);
		graphs.get(workspaceId)?.addNode({
			id: deriveSymbolNodeId({ path: absolutePath, line: 1, character: 1 }),
			name: "add",
			kind: "function",
			location: { path: absolutePath, line: 1, character: 1 },
		});

		const { annotation } = await service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "note",
			title: "relative anchor",
			body: "created via a workspace-relative path, not the graph's own absolute form",
			anchors: [{ path: "src/a.ts", line: 1, character: 1 }],
		});
		expect(annotation.status).toBe("fresh");
		expect(annotation.anchors[0]?.path).toBe(absolutePath);

		const { annotation: fetched } = await service.dispatch("workspace.getAnnotation", { workspaceId, id: annotation.id });
		expect(fetched?.status).toBe("fresh");
	});

	it("resolves an anchor whose column is off by a few characters from the graph's own recorded position -- the exact-position-fragility bug this fixes", async () => {
		fixtureRoot = buildFixture();
		const { service: svc, graphs } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");
		await warmGraph(service, workspaceId, path);
		// documentSymbols' own selectionRange.start recorded the declaration at character 17 (the
		// real name's own start), but the caller's anchor position (e.g. from a different LSP
		// request type, like workspace/symbol's own SymbolInformation.location) reports character 1
		// on the same line -- hover/goToDefinition would still resolve this to the same symbol.
		graphs
			.get(workspaceId)
			?.addNode({ id: deriveSymbolNodeId({ path, line: 1, character: 17 }), name: "add", kind: "function", location: { path, line: 1, character: 17 } });

		const { annotation } = await service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "comment",
			title: "off-by-a-few-characters",
			body: "anchored via a position the graph didn't record exactly",
			anchors: [{ path, line: 1, character: 1 }],
		});
		expect(annotation.status).toBe("fresh");
		// The stored anchor names the graph's own real node -- the nearest-declaration fallback
		// normalizes to the canonical position, it doesn't fabricate a new node at the caller's own.
		expect(annotation.anchors[0]?.symbolNodeId).toBe(deriveSymbolNodeId({ path, line: 1, character: 17 }));
	});

	it("still refuses an anchor when two candidate declarations on the same line are equally plausible -- never guesses across a real ambiguity", async () => {
		fixtureRoot = buildFixture();
		const { service: svc, graphs } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");
		await warmGraph(service, workspaceId, path);
		const graph = graphs.get(workspaceId);
		graph?.addNode({ id: deriveSymbolNodeId({ path, line: 1, character: 5 }), name: "left", kind: "variable", location: { path, line: 1, character: 5 } });
		graph?.addNode({ id: deriveSymbolNodeId({ path, line: 1, character: 15 }), name: "right", kind: "variable", location: { path, line: 1, character: 15 } });

		await expect(
			service.dispatch("workspace.createAnnotation", {
				workspaceId,
				subtype: "comment",
				title: "t",
				body: "b",
				anchors: [{ path, line: 1, character: 10 }],
			}),
		).rejects.toThrow(UnknownAnnotationAnchor);
	});

	it("rejects an anchor that does not resolve to any known symbol", async () => {
		fixtureRoot = buildFixture();
		const { service: svc } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");

		await expect(
			service.dispatch("workspace.createAnnotation", { workspaceId, subtype: "comment", title: "t", body: "b", anchors: [{ path, line: 1, character: 1 }] }),
		).rejects.toThrow(UnknownAnnotationAnchor);
	});

	it("rejects an annotation with zero anchors", async () => {
		fixtureRoot = buildFixture();
		const { service: svc } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });

		await expect(service.dispatch("workspace.createAnnotation", { workspaceId, subtype: "comment", title: "t", body: "b", anchors: [] })).rejects.toThrow(
			AnnotationRequiresAnchors,
		);
	});

	it("get() live-detects staleness when the anchored file's content changes on disk, and persists the correction", async () => {
		fixtureRoot = buildFixture();
		const { service: svc, graphs } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");
		await warmGraph(service, workspaceId, path);
		graphs
			.get(workspaceId)
			?.addNode({ id: deriveSymbolNodeId({ path, line: 1, character: 1 }), name: "add", kind: "function", location: { path, line: 1, character: 1 } });

		const { annotation } = await service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "comment",
			title: "t",
			body: "b",
			anchors: [{ path, line: 1, character: 1 }],
		});
		expect(annotation.status).toBe("fresh");

		writeFileSync(path, "export function add(a, b) { return a + b; }\n");

		const { annotation: firstRead } = await service.dispatch("workspace.getAnnotation", { workspaceId, id: annotation.id });
		expect(firstRead?.status).toBe("stale");

		// The persisted correction, not just the returned view -- list() must also see "stale".
		const { annotations } = await service.dispatch("workspace.listAnnotations", { workspaceId, status: "stale" });
		expect(annotations.map((a) => a.id)).toContain(annotation.id);
	});

	it("refresh re-resolves anchors and resets status to fresh", async () => {
		fixtureRoot = buildFixture();
		const { service: svc, graphs } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");
		await warmGraph(service, workspaceId, path);
		const graph = graphs.get(workspaceId);
		graph?.addNode({ id: deriveSymbolNodeId({ path, line: 1, character: 1 }), name: "add", kind: "function", location: { path, line: 1, character: 1 } });

		const { annotation } = await service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "comment",
			title: "t",
			body: "old narrative",
			anchors: [{ path, line: 1, character: 1 }],
		});

		writeFileSync(path, "export function add(a, b) { return a + b; }\n");
		graph?.addNode({ id: deriveSymbolNodeId({ path, line: 1, character: 1 }), name: "add", kind: "function", location: { path, line: 1, character: 1 } });

		const { annotation: refreshed } = await service.dispatch("workspace.refreshAnnotation", {
			workspaceId,
			id: annotation.id,
			subtype: "comment",
			title: "t",
			body: "new narrative",
			anchors: [{ path, line: 1, character: 1 }],
		});
		expect(refreshed?.status).toBe("fresh");
		expect(refreshed?.body).toBe("new narrative");
	});

	it("scrub excludes an annotation from listAnnotations, and restore returns it as stale", async () => {
		fixtureRoot = buildFixture();
		const { service: svc, graphs } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");
		await warmGraph(service, workspaceId, path);
		graphs
			.get(workspaceId)
			?.addNode({ id: deriveSymbolNodeId({ path, line: 1, character: 1 }), name: "add", kind: "function", location: { path, line: 1, character: 1 } });

		const { annotation } = await service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "comment",
			title: "t",
			body: "b",
			anchors: [{ path, line: 1, character: 1 }],
		});

		expect((await service.dispatch("workspace.scrubAnnotation", { workspaceId, id: annotation.id })).scrubbed).toBe(true);
		const { annotations } = await service.dispatch("workspace.listAnnotations", { workspaceId });
		expect(annotations.map((a) => a.id)).not.toContain(annotation.id);

		expect((await service.dispatch("workspace.restoreAnnotation", { workspaceId, id: annotation.id })).restored).toBe(true);
		// restore() itself persists "stale" (never assumes "fresh"), but under Option A every read
		// live-checks and self-corrects -- since nothing on disk actually changed, the anchor is
		// still genuinely valid, so the very next read reports "fresh", not the transient "stale".
		const { annotation: restored } = await service.dispatch("workspace.getAnnotation", { workspaceId, id: annotation.id });
		expect(restored?.status).toBe("fresh");
		const { annotations: listedAfterRestore } = await service.dispatch("workspace.listAnnotations", { workspaceId });
		expect(listedAfterRestore.map((a) => a.id)).toContain(annotation.id);
	});
});

describe("createLectorService's annotation containment operations", () => {
	async function createAnnotation(service: LectorService, workspaceId: WorkspaceId, path: string, title: string): Promise<{ id: string }> {
		const { annotation } = await service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "comment",
			title,
			body: "narrative content",
			anchors: [{ path, line: 1, character: 1 }],
		});
		return { id: annotation.id };
	}

	async function setUp(): Promise<{ service: LectorService; workspaceId: WorkspaceId; path: string }> {
		fixtureRoot = buildFixture();
		const { service: svc, graphs } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");
		await warmGraph(service, workspaceId, path);
		graphs
			.get(workspaceId)
			?.addNode({ id: deriveSymbolNodeId({ path, line: 1, character: 1 }), name: "add", kind: "function", location: { path, line: 1, character: 1 } });
		return { service, workspaceId, path };
	}

	it("contains, reports children/parents via annotationTree, and uncontains", async () => {
		const { service: svc, workspaceId, path } = await setUp();
		const flow = await createAnnotation(svc, workspaceId, path, "checkout flow");
		const step = await createAnnotation(svc, workspaceId, path, "validate payment");

		const { contained } = await svc.dispatch("workspace.containAnnotation", { workspaceId, parentId: flow.id, childId: step.id });
		expect(contained).toBe(true);

		const { annotations } = await svc.dispatch("workspace.annotationTree", { workspaceId, rootId: flow.id, maxDepth: 5 });
		expect(annotations.map((a) => a.id)).toEqual([flow.id, step.id]);

		const { uncontained } = await svc.dispatch("workspace.uncontainAnnotation", { workspaceId, parentId: flow.id, childId: step.id });
		expect(uncontained).toBe(true);
		const { annotations: afterUncontain } = await svc.dispatch("workspace.annotationTree", { workspaceId, rootId: flow.id, maxDepth: 5 });
		expect(afterUncontain.map((a) => a.id)).toEqual([flow.id]);
	});

	it("reuses one child annotation under two different parent flows -- the DRY reuse this feature exists for", async () => {
		const { service: svc, workspaceId, path } = await setUp();
		const flowA = await createAnnotation(svc, workspaceId, path, "flow A");
		const flowB = await createAnnotation(svc, workspaceId, path, "flow B");
		const shared = await createAnnotation(svc, workspaceId, path, "shared per-symbol note");

		await svc.dispatch("workspace.containAnnotation", { workspaceId, parentId: flowA.id, childId: shared.id });
		await svc.dispatch("workspace.containAnnotation", { workspaceId, parentId: flowB.id, childId: shared.id });

		const { annotations: fromA } = await svc.dispatch("workspace.annotationTree", { workspaceId, rootId: flowA.id, maxDepth: 5 });
		const { annotations: fromB } = await svc.dispatch("workspace.annotationTree", { workspaceId, rootId: flowB.id, maxDepth: 5 });
		expect(fromA.map((a) => a.id)).toContain(shared.id);
		expect(fromB.map((a) => a.id)).toContain(shared.id);
	});

	it("nests a data flow of data flows, bounded by annotationTree's own maxDepth", async () => {
		const { service: svc, workspaceId, path } = await setUp();
		const outer = await createAnnotation(svc, workspaceId, path, "outer flow");
		const inner = await createAnnotation(svc, workspaceId, path, "inner flow");
		const leaf = await createAnnotation(svc, workspaceId, path, "leaf note");
		await svc.dispatch("workspace.containAnnotation", { workspaceId, parentId: outer.id, childId: inner.id });
		await svc.dispatch("workspace.containAnnotation", { workspaceId, parentId: inner.id, childId: leaf.id });

		const { annotations: shallow } = await svc.dispatch("workspace.annotationTree", { workspaceId, rootId: outer.id, maxDepth: 1 });
		expect(shallow.map((a) => a.id)).toEqual([outer.id, inner.id]);

		const { annotations: full } = await svc.dispatch("workspace.annotationTree", { workspaceId, rootId: outer.id, maxDepth: 5 });
		expect(full.map((a) => a.id)).toEqual([outer.id, inner.id, leaf.id]);
	});

	it("rejects a containment cycle up front", async () => {
		const { service: svc, workspaceId, path } = await setUp();
		const a = await createAnnotation(svc, workspaceId, path, "a");
		const b = await createAnnotation(svc, workspaceId, path, "b");
		await svc.dispatch("workspace.containAnnotation", { workspaceId, parentId: a.id, childId: b.id });

		await expect(svc.dispatch("workspace.containAnnotation", { workspaceId, parentId: b.id, childId: a.id })).rejects.toThrow(AnnotationContainmentCycle);
	});

	it("rejects a direct self-containment", async () => {
		const { service: svc, workspaceId, path } = await setUp();
		const a = await createAnnotation(svc, workspaceId, path, "a");

		await expect(svc.dispatch("workspace.containAnnotation", { workspaceId, parentId: a.id, childId: a.id })).rejects.toThrow(AnnotationContainmentCycle);
	});

	it("rejects containment naming an id that does not exist", async () => {
		const { service: svc, workspaceId, path } = await setUp();
		const a = await createAnnotation(svc, workspaceId, path, "a");

		await expect(svc.dispatch("workspace.containAnnotation", { workspaceId, parentId: a.id, childId: "never-created" })).rejects.toThrow(
			UnknownAnnotationForContainment,
		);
	});

	it("uncontainAnnotation is idempotent on an already-absent relationship", async () => {
		const { service: svc, workspaceId, path } = await setUp();
		const a = await createAnnotation(svc, workspaceId, path, "a");
		const b = await createAnnotation(svc, workspaceId, path, "b");

		const { uncontained } = await svc.dispatch("workspace.uncontainAnnotation", { workspaceId, parentId: a.id, childId: b.id });
		expect(uncontained).toBe(false);
	});

	it("annotationTree applies live staleness to every node, not just the root", async () => {
		const { service: svc, workspaceId, path } = await setUp();
		const flow = await createAnnotation(svc, workspaceId, path, "flow");
		const step = await createAnnotation(svc, workspaceId, path, "step");
		await svc.dispatch("workspace.containAnnotation", { workspaceId, parentId: flow.id, childId: step.id });

		writeFileSync(path, "export function add() {}\nexport function extra() {}\n");

		const { annotations } = await svc.dispatch("workspace.annotationTree", { workspaceId, rootId: flow.id, maxDepth: 5 });
		expect(annotations.every((a) => a.status === "stale")).toBe(true);
	});
});
