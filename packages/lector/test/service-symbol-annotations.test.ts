/**
 * Service-level wiring for the annotation operations: create resolves real
 * anchor positions against a real graph and workspace, get/list live-check
 * staleness (option A) and persist a correction before returning, and
 * refresh/scrub/restore round-trip through the store. Domain-level
 * correctness of the staleness decision itself is already covered directly
 * in test/domain/symbol-annotation-staleness.test.ts and
 * test/domain/check-annotation-staleness.test.ts; this file only proves the
 * service dispatch, anchor resolution, and per-workspace store lifecycle
 * are wired correctly.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySymbolGraph } from "../src/adapters/in-memory-symbol-graph.ts";
import { AnnotationRequiresAnchors, createLectorService, type LectorService, UnknownAnnotationAnchor, type WorkspaceId } from "../src/service.ts";

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

describe("createLectorService's annotation operations", () => {
	it("creates an annotation anchored to a real symbol, and get() returns it fresh", async () => {
		fixtureRoot = buildFixture();
		const { service: svc, graphs } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const path = join(fixtureRoot, "src", "a.ts");
		await warmGraph(service, workspaceId, path);
		graphs.get(workspaceId)?.addNode({ id: `${path}:1:1`, name: "add", kind: "function", location: { path, line: 1, character: 1 } });

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

	it("resolves a workspace-relative anchor path to the same symbol a caller would reach with the absolute form", async () => {
		fixtureRoot = buildFixture();
		const { service: svc, graphs } = createServiceWithCapturedGraphs();
		service = svc;
		const { workspaceId } = await service.dispatch("workspace.registerPath", { path: fixtureRoot });
		const absolutePath = join(fixtureRoot, "src", "a.ts");
		await warmGraph(service, workspaceId, absolutePath);
		graphs.get(workspaceId)?.addNode({ id: `${absolutePath}:1:1`, name: "add", kind: "function", location: { path: absolutePath, line: 1, character: 1 } });

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
		graphs.get(workspaceId)?.addNode({ id: `${path}:1:1`, name: "add", kind: "function", location: { path, line: 1, character: 1 } });

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
		graph?.addNode({ id: `${path}:1:1`, name: "add", kind: "function", location: { path, line: 1, character: 1 } });

		const { annotation } = await service.dispatch("workspace.createAnnotation", {
			workspaceId,
			subtype: "comment",
			title: "t",
			body: "old narrative",
			anchors: [{ path, line: 1, character: 1 }],
		});

		writeFileSync(path, "export function add(a, b) { return a + b; }\n");
		graph?.addNode({ id: `${path}:1:1`, name: "add", kind: "function", location: { path, line: 1, character: 1 } });

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
		graphs.get(workspaceId)?.addNode({ id: `${path}:1:1`, name: "add", kind: "function", location: { path, line: 1, character: 1 } });

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
