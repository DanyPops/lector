import { InMemoryContentCache } from "../../src/content-cache/in-memory-content-cache.ts";
import { runContentCachePortConformanceSuite } from "../support/content-cache-port-conformance.ts";

runContentCachePortConformanceSuite("InMemoryContentCache", {
	createCache: () => new InMemoryContentCache(),
});
