/** Raised when a caller-influenced value could escape a directory layout built by joining path segments. */
export class UnsafePathSegment extends Error {
	constructor(
		readonly label: string,
		readonly value: string,
	) {
		super(`"${value}" is not a safe ${label} -- must be a single non-empty path segment with no separators or ".." `);
		this.name = "UnsafePathSegment";
	}
}

/** Rejects empty, ".", "..", or anything containing a path separator -- the values that let a caller-influenced segment escape a directory it was meant to stay inside. */
export function assertSafePathSegment(value: string, label: string): void {
	if (value.length === 0 || value === "." || value === ".." || value.includes("/") || value.includes("\\")) {
		throw new UnsafePathSegment(label, value);
	}
}
