export { annotationsContainedFrom, type ContainmentReader, wouldCreateContainmentCycle } from "./annotation-containment.ts";
export { checkAnnotationStaleness } from "./check-annotation-staleness.ts";
export { InMemorySymbolAnnotations } from "./in-memory-symbol-annotations.ts";
export type { SymbolAnnotationListOptions, SymbolAnnotationPort } from "./port.ts";
export { SqliteSymbolAnnotations } from "./sqlite-symbol-annotations.ts";
export type {
	AnnotationId,
	AnnotationStatus,
	CreateSymbolAnnotationInput,
	SymbolAnnotation,
	SymbolAnnotationAnchor,
} from "./symbol-annotation.ts";
export { type AnchorReality, isAnnotationStale } from "./symbol-annotation-staleness.ts";
