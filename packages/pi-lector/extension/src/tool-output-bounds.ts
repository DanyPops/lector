import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "@earendil-works/pi-coding-agent";

export interface BoundedLectorToolText {
	readonly text: string;
	readonly truncation: TruncationResult | undefined;
}

function noticeFor(truncation: TruncationResult): string {
	return (
		`[Lector tool output truncated: ${truncation.totalLines} lines total, ${formatSize(truncation.totalBytes)} total; ` +
		`showing ${truncation.outputLines} lines and ${formatSize(truncation.outputBytes)}. Refine the query or lower its scope.]`
	);
}

/**
 * Applies Pi's process-level custom-tool output contract independently of Lector's domain bounds.
 * Domain maxBytes values intentionally describe DTO payload fields, not the final serialized tool
 * message; this final guard accounts for separators, provenance, JSON framing, and caller-selected
 * bounds before content enters model context.
 */
export function boundLectorToolText(text: string): BoundedLectorToolText {
	const initial = truncateHead(text);
	if (!initial.truncated) return { text, truncation: undefined };

	let bounded = initial;
	for (let attempt = 0; attempt < 3; attempt++) {
		const notice = noticeFor(bounded);
		const noticeBytes = Buffer.byteLength(`\n\n${notice}`, "utf8");
		bounded = truncateHead(text, {
			maxLines: Math.max(1, DEFAULT_MAX_LINES - 2),
			maxBytes: Math.max(1, DEFAULT_MAX_BYTES - noticeBytes),
		});
	}
	const notice = noticeFor(bounded);
	return { text: bounded.content ? `${bounded.content}\n\n${notice}` : notice, truncation: bounded };
}
