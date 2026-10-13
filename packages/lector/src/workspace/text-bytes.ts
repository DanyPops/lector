import { diffArrays } from "diff";

export interface TextLine {
	readonly text: string;
	readonly ending: string;
}

export function textLines(content: string): TextLine[] {
	const lines = content.split("\n");
	return lines.map((line, index) => {
		const newline = index < lines.length - 1;
		const crlf = newline && line.endsWith("\r");
		return { text: crlf ? line.slice(0, -1) : line, ending: newline ? (crlf ? "\r\n" : "\n") : "" };
	});
}

export function dominantEnding(content: string, fallback = "\n"): string {
	const crlf = content.split("\r\n").length - 1;
	const lf = content.split("\n").length - 1 - crlf;
	return crlf === lf ? fallback : crlf > lf ? "\r\n" : "\n";
}

export function replacementLines(before: readonly TextLine[], after: readonly string[], fallback: string): TextLine[] {
	const result: TextLine[] = [];
	let position = 0;
	let removed: readonly TextLine[] = [];
	for (const change of diffArrays(
		before.map((line) => line.text),
		[...after],
	)) {
		if (change.removed) {
			removed = before.slice(position, position + change.value.length);
			position += change.value.length;
		} else if (change.added) {
			result.push(
				...change.value.map((text, index) => {
					const ending = removed[index]?.ending;
					return { text, ending: ending?.length ? ending : fallback };
				}),
			);
			removed = [];
		} else {
			result.push(...before.slice(position, position + change.value.length));
			position += change.value.length;
			removed = [];
		}
	}
	return result;
}

export function joinTextLines(lines: readonly TextLine[], fallback: string): string {
	return lines.map((line, index) => line.text + (index < lines.length - 1 ? line.ending || fallback : "")).join("");
}

export function retainBom(source: string, result: string): string {
	return source.startsWith("\uFEFF") || result.startsWith("\uFEFF") ? `\uFEFF${result.replace(/^\uFEFF+/, "")}` : result;
}

export function replacementText(source: string, replacement: string, fallback: string): string {
	const ending = dominantEnding(source, fallback);
	return joinTextLines(
		replacementLines(
			textLines(source),
			textLines(replacement).map((line) => line.text),
			ending,
		),
		ending,
	);
}
