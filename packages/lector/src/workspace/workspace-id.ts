import { createHash } from "node:crypto";

/**
 * WorkspaceId -- identifies which registered workspace an operation targets. There is no
 * default/implicit workspace: an operation must always name one explicitly (Locus
 * LCS-BUG-97/LCS-BUG-88 class -- an operation given no explicit target must never fall back to
 * "whatever was registered/used last").
 *
 * Deliberately NOT branded like ContentHash/SymbolNodeId, despite the audit finding that
 * flagged this asymmetry: those two identities are only ever minted internally from their own
 * hash function and never accepted as raw external input, so branding them blocks a real bug
 * class (an unrelated string substituting for a computed identity) at zero cost. WorkspaceId is
 * the opposite shape -- a caller-supplied identifier that crosses the CLI/JSON-RPC wire
 * constantly (every `--workspace <id>` flag, every operation's `workspaceId` field), and the
 * receiving process cannot "mint" it, only pass through what it already received. Branding was
 * attempted and reverted after it required ~345 call-site casts across 70 files (cli.ts's ~50
 * individual command functions plus 63 test files' registry fixtures) with no real validation
 * happening at nearly any of those cast sites -- the only genuine check (does this workspace
 * exist) already happens inside each handler via UnknownWorkspace. A brand that must be forced
 * on at the boundary via blind casts protects nothing a plain string didn't already.
 */
export type WorkspaceId = string;

/**
 * Deterministically derive a workspaceId from a resolved absolute path, so the same
 * directory always yields the same id -- across repeat calls AND across a daemon
 * restart, since nothing about this derivation depends on runtime/in-memory state.
 * A shorter digest than ContentHash's is deliberate: this identifies a workspace root
 * for addressing/logging, not a content value needing full collision resistance.
 */
export function deriveWorkspaceId(absolutePath: string): WorkspaceId {
	return createHash("sha256").update(absolutePath).digest("hex").slice(0, 16);
}
