import { InMemoryPackageSourceIndex } from "../../src/package-source/in-memory-package-source-index.ts";
import { runPackageSourceIndexPortConformanceSuite } from "../support/package-source-index-port-conformance.ts";

runPackageSourceIndexPortConformanceSuite("InMemoryPackageSourceIndex", {
	createStore: (maxEntries) => new InMemoryPackageSourceIndex({ maxEntries }),
});
