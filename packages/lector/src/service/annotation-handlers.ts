import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import { annotationsContainedFrom, wouldCreateContainmentCycle } from "../symbol-annotation/annotation-containment.ts";
import { checkAnnotationStaleness } from "../symbol-annotation/check-annotation-staleness.ts";
import { InMemorySymbolAnnotations } from "../symbol-annotation/in-memory-symbol-annotations.ts";
import type { SymbolAnnotationListOptions, SymbolAnnotationPort } from "../symbol-annotation/port.ts";
import type { SymbolAnnotation, SymbolAnnotationAnchor } from "../symbol-annotation/symbol-annotation.ts";
import type { SymbolGraphPort } from "../symbol-graph/port.ts";
import { deriveSymbolNodeId } from "../symbol-graph/symbol-node-id.ts";
import type { WorkspacePort } from "../workspace/port.ts";
import { AnnotationContainmentCycle, AnnotationRequiresAnchors, UnknownAnnotationAnchor, UnknownAnnotationForContainment, type WorkspaceId } from "./errors.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import { type MutableRegistry, resolveWorkspace } from "./workspace-registry.ts";

export interface AnnotationHandlerDeps {
	readonly registry: MutableRegistry;
	readonly graph: (workspaceId: WorkspaceId) => SymbolGraphPort;
	readonly createStore?: (workspaceId: WorkspaceId) => SymbolAnnotationPort;
}

export class AnnotationHandlers {
	private readonly stores = new Map<WorkspaceId, SymbolAnnotationPort>();
	readonly handlers;

	constructor(private readonly deps: AnnotationHandlerDeps) {
		this.handlers = {
			"workspace.createAnnotation": (registry: MutableRegistry, input: OperationInputs["workspace.createAnnotation"]) => this.create(registry, input),
			"workspace.getAnnotation": (registry: MutableRegistry, input: OperationInputs["workspace.getAnnotation"]) => this.get(registry, input),
			"workspace.listAnnotations": (registry: MutableRegistry, input: OperationInputs["workspace.listAnnotations"]) => this.list(registry, input),
			"workspace.refreshAnnotation": (registry: MutableRegistry, input: OperationInputs["workspace.refreshAnnotation"]) => this.refresh(registry, input),
			"workspace.scrubAnnotation": async (registry: MutableRegistry, input: OperationInputs["workspace.scrubAnnotation"]) => {
				resolveWorkspace(registry, input.workspaceId);
				return { scrubbed: await this.store(input.workspaceId).scrub(input.id) };
			},
			"workspace.restoreAnnotation": async (registry: MutableRegistry, input: OperationInputs["workspace.restoreAnnotation"]) => {
				resolveWorkspace(registry, input.workspaceId);
				return { restored: await this.store(input.workspaceId).restore(input.id) };
			},
			"workspace.containAnnotation": (registry: MutableRegistry, input: OperationInputs["workspace.containAnnotation"]) => this.contain(registry, input),
			"workspace.uncontainAnnotation": async (registry: MutableRegistry, input: OperationInputs["workspace.uncontainAnnotation"]) => {
				resolveWorkspace(registry, input.workspaceId);
				return { uncontained: await this.store(input.workspaceId).removeContainmentEdge(input.parentId, input.childId) };
			},
			"workspace.annotationTree": (registry: MutableRegistry, input: OperationInputs["workspace.annotationTree"]) => this.tree(registry, input),
		} satisfies {
			[Name in
				| "workspace.createAnnotation"
				| "workspace.getAnnotation"
				| "workspace.listAnnotations"
				| "workspace.refreshAnnotation"
				| "workspace.scrubAnnotation"
				| "workspace.restoreAnnotation"
				| "workspace.containAnnotation"
				| "workspace.uncontainAnnotation"
				| "workspace.annotationTree"]: (registry: MutableRegistry, input: OperationInputs[Name]) => Promise<OperationOutputs[Name]>;
		};
	}

	private store(workspaceId: WorkspaceId): SymbolAnnotationPort {
		let store = this.stores.get(workspaceId);
		if (!store) {
			store = this.deps.createStore?.(workspaceId) ?? new InMemorySymbolAnnotations();
			this.stores.set(workspaceId, store);
		}
		return store;
	}

	private async anchors(
		graph: SymbolGraphPort,
		workspace: WorkspacePort,
		positions: readonly { path: string; line: number; character: number }[],
	): Promise<SymbolAnnotationAnchor[]> {
		if (positions.length === 0) throw new AnnotationRequiresAnchors();
		const hashByPath = new Map<string, ContentHash>();
		const anchors: SymbolAnnotationAnchor[] = [];
		for (const position of positions) {
			const resolvedPath = workspace.resolvePath(position.path);
			const symbolNodeId = deriveSymbolNodeId({ ...position, path: resolvedPath });
			if (!(await graph.getNode(symbolNodeId))) throw new UnknownAnnotationAnchor(position.path, position.line, position.character);
			let hash = hashByPath.get(resolvedPath);
			if (hash === undefined) {
				const entry = await workspace.readEntry(resolvedPath);
				if (!entry.exists) throw new UnknownAnnotationAnchor(position.path, position.line, position.character);
				hash = contentHashOf(entry.content);
				hashByPath.set(resolvedPath, hash);
			}
			anchors.push({ symbolNodeId, path: resolvedPath, fileContentHash: hash });
		}
		return anchors;
	}

	private async liveStatus(
		graph: SymbolGraphPort,
		workspace: WorkspacePort,
		store: SymbolAnnotationPort,
		annotation: SymbolAnnotation,
	): Promise<SymbolAnnotation> {
		if (annotation.status === "scrubbed") return annotation;
		const wantedStatus: "fresh" | "stale" = (await checkAnnotationStaleness(graph, workspace, annotation)) ? "stale" : "fresh";
		if (annotation.status === wantedStatus) return annotation;
		return (await store.setStatus(annotation.id, wantedStatus)) ?? annotation;
	}

	private async create(
		registry: MutableRegistry,
		input: OperationInputs["workspace.createAnnotation"],
	): Promise<OperationOutputs["workspace.createAnnotation"]> {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const anchors = await this.anchors(this.deps.graph(input.workspaceId), workspace, input.anchors);
		return { annotation: await this.store(input.workspaceId).create({ subtype: input.subtype, title: input.title, body: input.body, anchors }) };
	}

	private async get(registry: MutableRegistry, input: OperationInputs["workspace.getAnnotation"]): Promise<OperationOutputs["workspace.getAnnotation"]> {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const store = this.store(input.workspaceId);
		const found = await store.get(input.id);
		return { annotation: found ? await this.liveStatus(this.deps.graph(input.workspaceId), workspace, store, found) : undefined };
	}

	private async list(registry: MutableRegistry, input: OperationInputs["workspace.listAnnotations"]): Promise<OperationOutputs["workspace.listAnnotations"]> {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const store = this.store(input.workspaceId);
		const options: SymbolAnnotationListOptions = { subtype: input.subtype, status: input.status, maxResults: input.maxResults, query: input.query };
		const found = await store.list(options);
		return { annotations: await Promise.all(found.map((annotation) => this.liveStatus(this.deps.graph(input.workspaceId), workspace, store, annotation))) };
	}

	private async refresh(
		registry: MutableRegistry,
		input: OperationInputs["workspace.refreshAnnotation"],
	): Promise<OperationOutputs["workspace.refreshAnnotation"]> {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const anchors = await this.anchors(this.deps.graph(input.workspaceId), workspace, input.anchors);
		return { annotation: await this.store(input.workspaceId).refresh(input.id, { subtype: input.subtype, title: input.title, body: input.body, anchors }) };
	}

	private async contain(
		registry: MutableRegistry,
		input: OperationInputs["workspace.containAnnotation"],
	): Promise<OperationOutputs["workspace.containAnnotation"]> {
		resolveWorkspace(registry, input.workspaceId);
		const store = this.store(input.workspaceId);
		if (!(await store.get(input.parentId))) throw new UnknownAnnotationForContainment(input.parentId);
		if (!(await store.get(input.childId))) throw new UnknownAnnotationForContainment(input.childId);
		if (await wouldCreateContainmentCycle(store, input.parentId, input.childId)) throw new AnnotationContainmentCycle(input.parentId, input.childId);
		return { contained: await store.addContainmentEdge(input.parentId, input.childId) };
	}

	private async tree(registry: MutableRegistry, input: OperationInputs["workspace.annotationTree"]): Promise<OperationOutputs["workspace.annotationTree"]> {
		const workspace = resolveWorkspace(registry, input.workspaceId);
		const store = this.store(input.workspaceId);
		const graph = this.deps.graph(input.workspaceId);
		const found = await annotationsContainedFrom(store, input.rootId, input.maxDepth);
		return { annotations: await Promise.all(found.map((annotation) => this.liveStatus(graph, workspace, store, annotation))) };
	}

	async close(): Promise<void> {
		const stores = Array.from(this.stores.values());
		this.stores.clear();
		await Promise.all(stores.map((store) => store.close()));
	}
}
