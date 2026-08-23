/**
 * Selects a CTF corpus by "tier:language" key rather than the ablation runner hard-coding a
 * single language's fixture -- every corpus module shares the same shape (a real materialized
 * fixture + a set of real CtfTask entries with their own outcome checkers) regardless of which
 * language-server backend its own checkers call.
 */
import { CTF_CORPUS } from "./ctf-corpus.ts";
import type { CtfTask } from "./ctf-corpus.ts";
export type { CtfTask } from "./ctf-corpus.ts";
import { CTF_CORPUS_PYTHON } from "./ctf-corpus-python.ts";
import { CTF_CORPUS_GO } from "./ctf-corpus-go.ts";
import { CTF_CORPUS_RUST } from "./ctf-corpus-rust.ts";
import { CTF_CORPUS_CPP } from "./ctf-corpus-cpp.ts";
import { CTF_CORPUS_TYPESCRIPT_MEDIUM } from "./ctf-corpus-typescript-medium.ts";
import { CTF_CORPUS_TYPESCRIPT_LARGE } from "./ctf-corpus-typescript-large.ts";
import { materializeTypeScriptReferenceFixture } from "../../test/support/typescript-reference-fixture.ts";
import { materializeTypescriptMediumAxiosFixture } from "../../test/support/typescript-medium-axios-fixture.ts";
import { materializeTypescriptLargePrettierFixture } from "../../test/support/typescript-large-prettier-fixture.ts";
import { materializePythonReferenceFixture } from "../../test/support/python-reference-fixture.ts";
import { materializeGoReferenceFixture } from "../../test/support/go-reference-fixture.ts";
import { materializeRustReferenceFixture } from "../../test/support/rust-reference-fixture.ts";
import { materializeCppReferenceFixture } from "../../test/support/cpp-reference-fixture.ts";

export interface CtfFixtureHandle {
	readonly root: string;
	dispose(): void;
}

export interface CtfCorpusModule {
	readonly tasks: readonly CtfTask[];
	materializeFixture(): CtfFixtureHandle;
}

export class UnknownCtfCorpus extends Error {
	constructor(
		readonly key: string,
		readonly knownKeys: readonly string[],
	) {
		super(`unknown CTF corpus "${key}" -- known corpora: ${knownKeys.join(", ")}`);
		this.name = "UnknownCtfCorpus";
	}
}

export const CTF_CORPORA: Readonly<Record<string, CtfCorpusModule>> = {
	"small:typescript": { tasks: CTF_CORPUS, materializeFixture: materializeTypeScriptReferenceFixture },
	"small:python": { tasks: CTF_CORPUS_PYTHON, materializeFixture: materializePythonReferenceFixture },
	"small:go": { tasks: CTF_CORPUS_GO, materializeFixture: materializeGoReferenceFixture },
	"small:rust": { tasks: CTF_CORPUS_RUST, materializeFixture: materializeRustReferenceFixture },
	"small:cpp": { tasks: CTF_CORPUS_CPP, materializeFixture: materializeCppReferenceFixture },
	"medium:typescript": { tasks: CTF_CORPUS_TYPESCRIPT_MEDIUM, materializeFixture: materializeTypescriptMediumAxiosFixture },
	"large:typescript": { tasks: CTF_CORPUS_TYPESCRIPT_LARGE, materializeFixture: materializeTypescriptLargePrettierFixture },
};

export function resolveCtfCorpus(key: string): CtfCorpusModule {
	const module = CTF_CORPORA[key];
	if (!module) throw new UnknownCtfCorpus(key, Object.keys(CTF_CORPORA));
	return module;
}
