export const DEFAULT_MODEL_CONTENT_BYTES = 32_768;
const MAX_COLLECTION_ENTRIES = 24;
const MAX_DEPTH = 4;

function scalarText(value: unknown): string | undefined {
	if (value === null) return "none";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
	return undefined;
}

function appendSemanticLines(lines: string[], value: unknown, path: string, depth: number): void {
	const scalar = scalarText(value);
	if (scalar !== undefined) {
		lines.push(`${path}: ${scalar}`);
		return;
	}
	if (depth >= MAX_DEPTH) {
		lines.push(`${path}: [nested value omitted]`);
		return;
	}
	if (Array.isArray(value)) {
		lines.push(`${path} (${value.length})`);
		for (const [index, entry] of value.slice(0, MAX_COLLECTION_ENTRIES).entries()) appendSemanticLines(lines, entry, `${path}[${index}]`, depth + 1);
		if (value.length > MAX_COLLECTION_ENTRIES) lines.push(`${path}: ${value.length - MAX_COLLECTION_ENTRIES} more entries omitted`);
		return;
	}
	if (typeof value === "object" && value !== null) {
		const entries = Object.entries(value).slice(0, MAX_COLLECTION_ENTRIES);
		if (entries.length === 0) lines.push(`${path}: none`);
		for (const [key, entry] of entries) appendSemanticLines(lines, entry, path ? `${path}.${key}` : key, depth + 1);
		if (Object.keys(value).length > MAX_COLLECTION_ENTRIES) lines.push(`${path || "result"}: additional fields omitted`);
		return;
	}
	lines.push(`${path}: unavailable`);
}

/** Bounds UTF-8 model-facing text independently from presentation details. */
export function boundModelContentText(full: string, maxBytes = DEFAULT_MODEL_CONTENT_BYTES): string {
	if (!Number.isInteger(maxBytes) || maxBytes < 64) throw new Error("model content maxBytes must be an integer of at least 64");
	if (Buffer.byteLength(full, "utf8") <= maxBytes) return full;
	const suffix = "\n[model content truncated]";
	const budget = maxBytes - Buffer.byteLength(suffix, "utf8");
	let bytes = Buffer.from(full, "utf8").subarray(0, Math.max(0, budget));
	let prefix = "";
	while (bytes.length > 0) {
		try {
			prefix = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
			break;
		} catch {
			bytes = bytes.subarray(0, -1);
		}
	}
	return `${prefix}${suffix}`;
}

/** Formats an operation outcome as bounded, semantic plain text for model consumption. */
export function formatSemanticModelContent(title: string, value: unknown, maxBytes = DEFAULT_MODEL_CONTENT_BYTES): string {
	const lines = [title];
	appendSemanticLines(lines, value, "", 0);
	return boundModelContentText(lines.join("\n"), maxBytes);
}
