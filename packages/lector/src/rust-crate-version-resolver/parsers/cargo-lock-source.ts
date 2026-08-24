export interface ParsedCargoLockSource {
	readonly kind: "registry" | "git" | "path";
	readonly registryUrl: string | null;
	readonly directSource: string | null;
	/** The exact commit -- always present for a git source in a real Cargo.lock, since Cargo resolves and records it as the URL's own `#<sha>` fragment regardless of whether the dependency was pinned by rev, tag, or branch. */
	readonly commit: string | null;
	/** A tag or branch name, when the dependency was pinned by one rather than an explicit `rev`. */
	readonly gitRef: string | null;
}

/**
 * Classifies a Cargo.lock `[[package]]` entry's own `source` field. A workspace-local crate has
 * no `source` field at all (`null`) -- distinct from every registry/git crate, which always
 * carries one. A git source's URL always carries its own resolved commit as a `#<sha>` fragment,
 * regardless of whether the original pin was a `rev`, `tag`, or `branch` query parameter.
 */
export function parseCargoLockSource(source: string | null): ParsedCargoLockSource {
	if (source === null) return { kind: "path", registryUrl: null, directSource: null, commit: null, gitRef: null };
	if (source.startsWith("registry+")) {
		return { kind: "registry", registryUrl: source.slice("registry+".length), directSource: null, commit: null, gitRef: null };
	}
	if (source.startsWith("git+")) {
		const withoutPrefix = source.slice("git+".length);
		const [beforeFragment, commit] = withoutPrefix.split("#");
		const [url, query] = (beforeFragment ?? "").split("?");
		const params = new URLSearchParams(query ?? "");
		const gitRef = params.get("tag") ?? params.get("branch");
		return { kind: "git", registryUrl: null, directSource: url ?? null, commit: commit ?? null, gitRef };
	}
	return { kind: "path", registryUrl: null, directSource: null, commit: null, gitRef: null };
}
