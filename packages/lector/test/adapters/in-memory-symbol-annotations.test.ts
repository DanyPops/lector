import { InMemorySymbolAnnotations } from "../../src/adapters/in-memory-symbol-annotations.ts";
import { runSymbolAnnotationPortConformanceSuite } from "../support/symbol-annotation-port-conformance.ts";

runSymbolAnnotationPortConformanceSuite("InMemorySymbolAnnotations", {
	createPort: () => new InMemorySymbolAnnotations(),
});
