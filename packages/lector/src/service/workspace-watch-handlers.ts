import { randomUUID } from "node:crypto";
import picomatch from "picomatch";
import type { FileChangeEvent } from "../file-watcher/file-change-event.ts";
import type { FileWatcherPort } from "../file-watcher/port.ts";
import { WatchRegistry } from "../file-watcher/watch-registry.ts";
import { type MutableRegistry, type OperationInputs, type OperationOutputs, SymbolQueryUnavailable, UnknownWorkspace, type WorkspaceId } from "../service.ts";

export interface WorkspaceWatchHandlerDeps {
	readonly registry: MutableRegistry;
	readonly createWatcher: () => FileWatcherPort;
	readonly publish: (topic: string, payload: unknown) => void;
	readonly notifyWarmIndexes: (workspaceId: WorkspaceId, event: FileChangeEvent) => void;
	readonly isGraphWatched: (workspaceId: WorkspaceId) => boolean;
	readonly scheduleGraphRefresh: (workspaceId: WorkspaceId) => void;
}

export class WorkspaceWatchHandlers {
	private readonly registrations = new WatchRegistry();
	private readonly osWatchers = new Map<WorkspaceId, { close(): void }>();
	readonly handlers;

	constructor(private readonly deps: WorkspaceWatchHandlerDeps) {
		this.handlers = {
			"workspace.watch": (registry: MutableRegistry, input: OperationInputs["workspace.watch"]) => this.watch(registry, input),
			"workspace.unwatch": (_registry: MutableRegistry, input: OperationInputs["workspace.unwatch"]) => Promise.resolve(this.unwatch(input)),
		};
	}

	ensureOsWatcher(workspaceId: WorkspaceId, rootPath: string): void {
		if (this.osWatchers.has(workspaceId)) return;
		const handle = this.deps.createWatcher().watch(rootPath, (event) => this.handleFileChange(workspaceId, event));
		this.osWatchers.set(workspaceId, handle);
	}

	private handleFileChange(workspaceId: WorkspaceId, event: FileChangeEvent): void {
		for (const registration of this.registrations.registrationsFor(workspaceId)) {
			if (picomatch(registration.pattern)(event.path)) this.deps.publish(registration.topic, event);
		}
		this.deps.notifyWarmIndexes(workspaceId, event);
		const isGitInternal = event.path === ".git" || event.path.startsWith(".git/");
		if (!isGitInternal && this.deps.isGraphWatched(workspaceId)) this.deps.scheduleGraphRefresh(workspaceId);
	}

	private async watch(registry: MutableRegistry, input: OperationInputs["workspace.watch"]): Promise<OperationOutputs["workspace.watch"]> {
		const entry = registry.get(input.workspaceId);
		if (!entry) throw new UnknownWorkspace(input.workspaceId);
		if (!entry.rootPath) throw new SymbolQueryUnavailable(input.workspaceId);
		if (!input.pattern) throw new TypeError("workspace.watch requires a non-empty pattern");
		const watchId = randomUUID();
		const topic = `watch:${watchId}`;
		this.registrations.add(input.workspaceId, input.pattern, watchId, topic);
		this.ensureOsWatcher(input.workspaceId, entry.rootPath);
		return { watchId, topic };
	}

	private unwatch(input: OperationInputs["workspace.unwatch"]): OperationOutputs["workspace.unwatch"] {
		const removed = this.registrations.remove(input.watchId);
		if (removed && !this.registrations.hasAnyFor(removed.workspaceId) && !this.deps.isGraphWatched(removed.workspaceId)) {
			this.osWatchers.get(removed.workspaceId)?.close();
			this.osWatchers.delete(removed.workspaceId);
		}
		return { unwatched: removed !== undefined };
	}

	close(): void {
		for (const watcher of this.osWatchers.values()) watcher.close();
		this.osWatchers.clear();
	}
}
