/**
 * Compile-time contract check: does each Lector*Port class still structurally satisfy the
 * pinned snapshot of Alef's real @dpopsuev/alef-workspace port contract? This package has
 * no runtime or build dependency on Alef's repo (see each src/*-port.ts's own doc comment),
 * so there is no npm/workspace dependency to lean on for this -- the snapshot fixtures under
 * test/support/alef-workspace-contract-snapshot/ are a manually-refreshed, checked-in copy
 * of Alef's real interfaces instead.
 *
 * The real check is the `extends ... ? true : never` type below each import block: if a
 * Lector*Port class drops a method, narrows a return type, or otherwise stops satisfying the
 * pinned interface, that type resolves to `never` and `bun run typecheck` fails loudly on this
 * file -- a real compile error, not a silent runtime break discovered later in Alef. `bun test`
 * itself only proves the file runs; the type-level assertions below are what `tsc --noEmit`
 * (this package's own `typecheck` script) actually enforces.
 *
 * This snapshot is NOT auto-synced from Alef's live source -- if Alef's real contract changes,
 * the fixture files must be updated by hand to match before this check means anything against
 * Alef's current HEAD. See each fixture's own header for its pinned-as-of date.
 */
import { describe, expect, it } from "bun:test";
import type { LectorCallGraphPort } from "../src/call-graph-port.ts";
import type { LectorCodeIntelligencePort } from "../src/code-intelligence-port.ts";
import type { LectorFilesystemPort } from "../src/filesystem-port.ts";
import type { LectorGitPort } from "../src/git-port.ts";
import type { CallGraphPort as PinnedCallGraphPort } from "./support/alef-workspace-contract-snapshot/call-graph-port.ts";
import type { CodeIntelligencePort as PinnedCodeIntelligencePort } from "./support/alef-workspace-contract-snapshot/code-intelligence-port.ts";
import type { WorkspaceFilesystemPort as PinnedWorkspaceFilesystemPort } from "./support/alef-workspace-contract-snapshot/filesystem-port.ts";
import type { WorkspaceGitPort as PinnedWorkspaceGitPort } from "./support/alef-workspace-contract-snapshot/git-port.ts";

type GitPortSatisfiesContract = LectorGitPort extends PinnedWorkspaceGitPort ? true : never;
const gitPortSatisfiesContract: GitPortSatisfiesContract = true;

type CodeIntelligencePortSatisfiesContract = LectorCodeIntelligencePort extends PinnedCodeIntelligencePort ? true : never;
const codeIntelligencePortSatisfiesContract: CodeIntelligencePortSatisfiesContract = true;

type CallGraphPortSatisfiesContract = LectorCallGraphPort extends PinnedCallGraphPort ? true : never;
const callGraphPortSatisfiesContract: CallGraphPortSatisfiesContract = true;

type FilesystemPortSatisfiesContract = LectorFilesystemPort extends PinnedWorkspaceFilesystemPort ? true : never;
const filesystemPortSatisfiesContract: FilesystemPortSatisfiesContract = true;

describe("Lector*Port classes against the pinned Alef contract snapshot", () => {
	it("LectorGitPort still structurally satisfies WorkspaceGitPort v1 -- see the type-level check above, enforced by `bun run typecheck`", () => {
		expect(gitPortSatisfiesContract).toBe(true);
	});

	it("LectorCodeIntelligencePort still structurally satisfies CodeIntelligencePort v1", () => {
		expect(codeIntelligencePortSatisfiesContract).toBe(true);
	});

	it("LectorCallGraphPort still structurally satisfies CallGraphPort v1", () => {
		expect(callGraphPortSatisfiesContract).toBe(true);
	});

	it("LectorFilesystemPort still structurally satisfies WorkspaceFilesystemPort v1", () => {
		expect(filesystemPortSatisfiesContract).toBe(true);
	});
});
