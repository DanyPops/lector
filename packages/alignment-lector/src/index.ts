// Deep imports (not the "@danypops/lector" barrel) deliberately: the barrel's own index.ts
// re-exports the whole daemon/service/adapter surface (Bun-only sqlite adapters, the real
// typescript/pyright compilers, tree-sitter grammars, ...). A bundler pulling in the barrel
// for just these two runtime symbols drags every one of those in too -- a real, confirmed
// break for a Node-targeted consumer bundling this package (esbuild fails on typescript.js's
// own dynamic `require("fs")` once it is reachable at all). Each deep path names its own real,
// leaf-level module with no such transitive weight.
export { GuardedLiveBuffer, type LiveBufferIdentity, type StaleBufferState } from "@danypops/lector/live-buffer/guarded";
export type {
	CallGraphDirection,
	CallGraphEdgeProjection,
	CallGraphLocation,
	CallGraphNodeProjection,
	CallGraphProjection,
	CallGraphStatus,
} from "./call-graph.js";
export { createLectorAlignmentContribution } from "./contribution.js";
export type {
	GitDiffFileProjection,
	GitFileState,
	GitHunkProjection,
	GitOpenIntent,
	GitStatusFileProjection,
} from "./git-contribution.js";
export { authenticatedLectorOperations, type LectorOperations, lectorOperationsFromClient } from "./lector-operations.js";
export type { SemanticProvenance, SemanticResultProjection, SemanticStatus } from "./semantic-navigation.js";
