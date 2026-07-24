/**
 * Shared conformance suite for any LanguageServerDescriptor, run against its
 * real server process, not a mock. Every language added to
 * LANGUAGE_SERVER_DESCRIPTORS must pass this.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";
import { LspSymbolIndex } from "../../src/adapters/lsp/lsp-symbol-index.ts";
import { measureProcessTreeRssKb } from "../../src/adapters/lsp/process-resource-usage.ts";
import { documentSymbols } from "../../src/domain/document-symbols.ts";
import { goToDefinition } from "../../src/domain/go-to-definition.ts";
import type { LanguageServerDescriptor } from "../../src/domain/language-server-descriptor.ts";
import { findPositionOf } from "./find-position.ts";

export interface LanguageConformanceFixture {
	readonly languageName: string;
	readonly descriptor: LanguageServerDescriptor;
	readonly seedFile: string;
	/** Builds a fresh temp project directory containing real source files; returns its root and the absolute path to the file declaring expectedSymbolNames. */
	buildRoot(): string;
	readonly mainFile: (root: string) => string;
	readonly expectedSymbolNames: readonly string[];
	/** A unique substring of a real call-usage line, and the character offset within it landing on the callee identifier. Omit for a language with no call-navigation semantics (e.g. YAML). */
	readonly callUsage?: { substring: string; offsetWithinSubstring: number };
	readonly timeoutMs?: number;
	/** Ceiling for this server's own RSS, including child processes, against a trivial single-file fixture -- catches a real leak/explosion, not a tight regression gate. Measured baselines (packages/lector/benchmarks/language-server-cold-start.ts): typescript ~570MB, rust ~610MB, go ~420MB, python/cpp ~150-160MB, bash/yaml ~95-100MB. */
	readonly expectedMaxRssMb: number;
}

export function runLanguageServerConformanceSuite(fixture: LanguageConformanceFixture): void {
	let fixtureRoot: string | undefined;
	let index: LspSymbolIndex | undefined;
	const timeout = fixture.timeoutMs ?? 30_000;

	afterEach(async () => {
		await index?.close();
		index = undefined;
		if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
		fixtureRoot = undefined;
	});

	describe(`LspSymbolIndex configured for ${fixture.languageName}`, () => {
		it(
			"documentSymbols lists the real declarations a live server reports",
			async () => {
				fixtureRoot = fixture.buildRoot();
				index = new LspSymbolIndex(fixtureRoot, fixture.descriptor, fixture.seedFile);
				const mainFile = fixture.mainFile(fixtureRoot);

				const symbols = await documentSymbols(index, mainFile);

				for (const name of fixture.expectedSymbolNames) {
					expect(symbols.find((symbol) => symbol.name === name)).toBeDefined();
				}

				const pid = index.processId;
				const rssKb = pid !== undefined ? measureProcessTreeRssKb(pid) : undefined;
				if (rssKb !== undefined) expect(rssKb / 1024).toBeLessThan(fixture.expectedMaxRssMb);
			},
			timeout,
		);

		if (fixture.callUsage) {
			const { substring, offsetWithinSubstring } = fixture.callUsage;
			it(
				"goToDefinition resolves a real cross-line call to its declaration",
				async () => {
					fixtureRoot = fixture.buildRoot();
					index = new LspSymbolIndex(fixtureRoot, fixture.descriptor, fixture.seedFile);
					const mainFile = fixture.mainFile(fixtureRoot);
					const usage = findPositionOf(mainFile, substring);
					const at = { path: mainFile, line: usage.line, character: usage.character + offsetWithinSubstring };

					const locations = await goToDefinition(index, at);

					expect(locations.length).toBeGreaterThan(0);
					expect(locations[0]?.path).toBe(mainFile);
				},
				timeout,
			);
		}
	});
}
