import type { CodeRange } from "./code-range.ts";
import type { WorkspaceLocation } from "./workspace-symbol.ts";

/** One node in a call hierarchy: a function/method the server resolved a position to. */
export interface CallHierarchyEntry {
	readonly name: string;
	readonly kind: string;
	readonly detail?: string;
	readonly location: WorkspaceLocation;
	readonly range: CodeRange;
}

/** A caller of the hierarchy root, and the specific ranges within it that make the call. */
export interface IncomingCall {
	readonly from: CallHierarchyEntry;
	readonly fromRanges: CodeRange[];
}

/** A callee of the hierarchy root, and the specific ranges within the root that call it. */
export interface OutgoingCall {
	readonly to: CallHierarchyEntry;
	readonly fromRanges: CodeRange[];
}
