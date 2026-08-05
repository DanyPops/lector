/**
 * "ready" -- the query completed and `result` is the real answer.
 * "loading" -- the underlying work (e.g. a cold-starting language server) hadn't finished within
 * the caller's own budget when this was reported. This is not "not found" and not a failure: the
 * work keeps running in the background (LspSymbolIndex's own initialization is cached and
 * shared, never duplicated by a later call), so the caller can retry shortly and get "ready".
 * A caller (human or agent) must be able to tell "there's nothing here" apart from "there might
 * be something here, it just isn't ready yet" -- collapsing both into an empty result is exactly
 * the silent-failure shape this project has repeatedly found and fixed elsewhere (pyright's
 * workspaceFolders bug, the eslint.config.ts seed-file bug) for a single workspace; a fan-out
 * across many workspaces multiplies the chance of hitting a still-cold one.
 * "error" -- the query for this one workspace genuinely failed (e.g. an unsupported language).
 * Reported per-workspace rather than aborting the whole fan-out, so one bad workspace can't sink
 * every other workspace's real results.
 *
 * A real discriminated union, not one interface with optional fields -- so `status === "ready"`
 * narrows `result` to defined without a caller needing its own assertion.
 */
export type WorkspaceQueryOutcome<T> =
	| { readonly workspaceId: string; readonly status: "ready"; readonly result: T }
	| { readonly workspaceId: string; readonly status: "loading"; readonly message: string }
	| { readonly workspaceId: string; readonly status: "error"; readonly message: string };

export type WorkspaceQueryStatus = WorkspaceQueryOutcome<unknown>["status"];
