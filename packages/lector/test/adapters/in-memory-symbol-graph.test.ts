import { InMemorySymbolGraph } from "../../src/adapters/in-memory-symbol-graph.ts";
import { runSymbolGraphPortConformanceSuite } from "../support/symbol-graph-port-conformance.ts";

runSymbolGraphPortConformanceSuite("InMemorySymbolGraph", {
	createGraph: () => new InMemorySymbolGraph(),
});
