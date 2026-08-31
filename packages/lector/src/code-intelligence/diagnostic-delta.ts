import type { Diagnostic } from "./diagnostic.ts";

export interface ChangedDiagnostic {
	readonly before: Diagnostic;
	readonly after: Diagnostic;
}

export interface DiagnosticDelta {
	readonly introduced: readonly Diagnostic[];
	readonly resolved: readonly Diagnostic[];
	readonly changed: readonly ChangedDiagnostic[];
}

function normalizedMessage(message: string): string {
	return message.trim().replace(/\s+/g, " ");
}

function normalizedSource(source: string | undefined): string {
	return (source ?? "").trim().toLowerCase();
}

function associationKey(diagnostic: Diagnostic): string {
	const stableCode = diagnostic.code === undefined ? `message:${normalizedMessage(diagnostic.message)}` : `code:${String(diagnostic.code)}`;
	return JSON.stringify([diagnostic.range.path, normalizedSource(diagnostic.source), stableCode]);
}

function normalizedValue(diagnostic: Diagnostic): string {
	return JSON.stringify([
		diagnostic.range,
		diagnostic.severity,
		normalizedMessage(diagnostic.message),
		normalizedSource(diagnostic.source),
		diagnostic.code ?? null,
	]);
}

function compareDiagnostics(left: Diagnostic, right: Diagnostic): number {
	return (
		left.range.path.localeCompare(right.range.path) ||
		left.range.start.line - right.range.start.line ||
		left.range.start.character - right.range.start.character ||
		left.range.end.line - right.range.end.line ||
		left.range.end.character - right.range.end.character ||
		normalizedMessage(left.message).localeCompare(normalizedMessage(right.message))
	);
}

function grouped(diagnostics: readonly Diagnostic[]): Map<string, Diagnostic[]> {
	const groups = new Map<string, Diagnostic[]>();
	for (const diagnostic of diagnostics) {
		const key = associationKey(diagnostic);
		const entries = groups.get(key) ?? [];
		entries.push(diagnostic);
		groups.set(key, entries);
	}
	for (const entries of groups.values()) entries.sort(compareDiagnostics);
	return groups;
}

/** Classifies stable before/after diagnostic differences while preserving original report detail. */
export function diagnosticDelta(before: readonly Diagnostic[], after: readonly Diagnostic[]): DiagnosticDelta {
	const beforeGroups = grouped(before);
	const afterGroups = grouped(after);
	const introduced: Diagnostic[] = [];
	const resolved: Diagnostic[] = [];
	const changed: ChangedDiagnostic[] = [];
	const keys = [...new Set([...beforeGroups.keys(), ...afterGroups.keys()])].sort();
	for (const key of keys) {
		const previous = beforeGroups.get(key) ?? [];
		const current = afterGroups.get(key) ?? [];
		const paired = Math.min(previous.length, current.length);
		for (let index = 0; index < paired; index += 1) {
			const beforeDiagnostic = previous[index];
			const afterDiagnostic = current[index];
			if (!beforeDiagnostic || !afterDiagnostic) continue;
			if (normalizedValue(beforeDiagnostic) !== normalizedValue(afterDiagnostic)) changed.push({ before: beforeDiagnostic, after: afterDiagnostic });
		}
		resolved.push(...previous.slice(paired));
		introduced.push(...current.slice(paired));
	}
	introduced.sort(compareDiagnostics);
	resolved.sort(compareDiagnostics);
	changed.sort((left, right) => compareDiagnostics(left.after, right.after));
	return { introduced, resolved, changed };
}
