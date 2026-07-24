import { readFileSync } from "node:fs";

/**
 * Finds the 1-indexed line/character of the first occurrence of `needle` in a
 * real file, so position-based test fixtures (goToDefinition, findReferences,
 * hover) stay correct as the dogfooded source file's exact formatting shifts
 * over time, rather than pinning brittle hardcoded line numbers.
 */
export function findPositionOf(filePath: string, needle: string): { line: number; character: number } {
	const content = readFileSync(filePath, "utf-8");
	const lines = content.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const column = lines[index]?.indexOf(needle) ?? -1;
		if (column >= 0) return { line: index + 1, character: column + 1 };
	}
	throw new Error(`"${needle}" not found in ${filePath}`);
}
