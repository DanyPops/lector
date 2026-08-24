export interface ParsedGoWork {
	/** Every directory a `use` directive names -- each one has its own go.mod worth checking, since a real Go workspace's separate modules can each require a different version of the same external dependency. */
	readonly useDirectories: readonly string[];
}

/** Parses a real go.work's own `use` directives (single-line and grouped `use (...)` block form). Workspace-scoped `replace` overrides are out of scope -- none of this resolver's real fixtures exercise them, and go.mod's own replace handling already covers the shared grammar. */
export function parseGoWork(text: string): ParsedGoWork {
	const useDirectories: string[] = [];
	let inBlock = false;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (inBlock) {
			if (line === ")") {
				inBlock = false;
				continue;
			}
			if (line.length > 0) useDirectories.push(line);
			continue;
		}
		if (line === "use (") {
			inBlock = true;
			continue;
		}
		if (line.startsWith("use ")) {
			const directory = line.slice("use ".length).trim();
			if (directory.length > 0) useDirectories.push(directory);
		}
	}
	return { useDirectories };
}
