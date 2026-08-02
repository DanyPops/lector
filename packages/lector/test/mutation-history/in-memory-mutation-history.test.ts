import { InMemoryMutationHistory } from "../../src/mutation-history/in-memory-mutation-history.ts";
import { runMutationHistoryPortConformanceSuite } from "../support/mutation-history-port-conformance.ts";

runMutationHistoryPortConformanceSuite("InMemoryMutationHistory", {
	createStore: (maxEntriesPerFile) => new InMemoryMutationHistory(maxEntriesPerFile),
});
