/**
 * The domain core performs a raw read and an exact edit against an
 * in-memory workspace, with no service, transport, or persistence involved
 * at all. The assertions themselves live in the shared WorkspacePort
 * conformance suite (test/support) so every future adapter is held to the
 * exact same contract.
 */
import { InMemoryWorkspace } from "../src/adapters/in-memory-workspace.ts";
import { runWorkspacePortConformanceSuite } from "./support/workspace-port-conformance.ts";

runWorkspacePortConformanceSuite("InMemoryWorkspace", {
	createWorkspace: () => new InMemoryWorkspace(),
});
