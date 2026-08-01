import { InMemoryPackageSourceIndex } from "../../src/adapters/in-memory-package-source-index.ts";
import { runPackageSourceIndexPortConformanceSuite } from "../support/package-source-index-port-conformance.ts";

runPackageSourceIndexPortConformanceSuite("InMemoryPackageSourceIndex", {
	createStore: (maxEntries) => new InMemoryPackageSourceIndex({ maxEntries }),
});
