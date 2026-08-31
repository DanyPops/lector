import type { CodeRange } from "../workspace/code-range.ts";
import type { WorkspaceLocation } from "../workspace/workspace-symbol.ts";
import type { CodeIntelligencePort } from "./port.ts";

/** Describes one language-server-resolved type and its exact declaration location. */
export interface TypeHierarchyEntry {
	readonly name: string;
	readonly kind: string;
	readonly detail?: string;
	readonly location: WorkspaceLocation;
	readonly range: CodeRange;
}

/** Resolves the type-hierarchy root at a source position. */
export async function prepareTypeHierarchy(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<TypeHierarchyEntry[]> {
	if (!index.prepareTypeHierarchy) throw new TypeHierarchyUnavailable();
	return index.prepareTypeHierarchy(at);
}

/** Resolves every direct supertype of the type at a source position. */
export async function supertypes(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<TypeHierarchyEntry[]> {
	if (!index.supertypes) throw new TypeHierarchyUnavailable();
	return index.supertypes(at);
}

/** Resolves every direct subtype of the type at a source position. */
export async function subtypes(index: CodeIntelligencePort, at: WorkspaceLocation): Promise<TypeHierarchyEntry[]> {
	if (!index.subtypes) throw new TypeHierarchyUnavailable();
	return index.subtypes(at);
}

export class TypeHierarchyUnavailable extends Error {
	constructor() {
		super("The code-intelligence backend does not support LSP type hierarchy");
		this.name = "TypeHierarchyUnavailable";
	}
}
