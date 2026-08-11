import { readFileSync } from "node:fs";
import ts from "typescript";

/**
 * The real type TypeScript's own checker resolves for an identifier, split into the type its own
 * declaration carries (`declaredType`, before any flow-sensitive narrowing) and the type at the
 * exact queried position (`narrowedType`, after it) -- `narrowed` is true exactly when a real
 * control-flow-sensitive fact (a `typeof`/`instanceof` guard, a reassignment, a truthiness check)
 * changed the answer. This is the concrete, positive proof that real dataflow -- not just nominal
 * declared typing -- was consulted to answer the query.
 */
export interface NarrowedType {
	readonly declaredType: string;
	readonly narrowedType: string;
	readonly narrowed: boolean;
}

/**
 * A single-file `ts.Program` and default `CompilerOptions` permissive enough to type-check most
 * real TypeScript/JavaScript without a project's own tsconfig.json -- deliberately not full
 * project-aware module resolution (see narrowedTypeAtPosition's own doc comment for the honest
 * scope this buys and costs).
 */
const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
	target: ts.ScriptTarget.Latest,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.Bundler,
	allowJs: true,
	checkJs: false,
	strict: true,
	noEmit: true,
	skipLibCheck: true,
};

/**
 * Whether `line`/`character` (1-indexed) is a real position within `sourceFile` -- checked before
 * ever calling `getPositionOfLineAndCharacter`, which asserts internally (`Debug Failure: False
 * expression`, an unhandled internal TypeScript compiler crash, not a clean thrown Error) rather
 * than validating its own bounds. Confirmed live: an out-of-range character on an otherwise
 * perfectly ordinary short line reproduces this exact crash -- a real, plausible caller mistake
 * (a stale cached line length, an off-by-one), not a contrived edge case.
 */
function isWithinSourceFile(sourceFile: ts.SourceFile, line: number, character: number): boolean {
	const lineIndex = line - 1;
	const characterIndex = character - 1;
	if (lineIndex < 0 || characterIndex < 0) return false;
	const lineStarts = sourceFile.getLineStarts();
	const lineStart = lineStarts[lineIndex];
	if (lineStart === undefined) return false;
	// The next line's own start (or the file's end, for the last line) bounds this line's own
	// length -- a position is valid anywhere up to and including that bound (the end of the line
	// itself is a legal position, e.g. right after the last character).
	const nextLineStart = lineStarts[lineIndex + 1];
	const lineEnd = nextLineStart ?? sourceFile.text.length;
	return lineStart + characterIndex <= lineEnd;
}

/** The innermost node whose span contains `position` -- the same "touching token" technique tsserver itself uses to resolve a raw offset to a real AST node. */
function nodeAtPosition(sourceFile: ts.SourceFile, position: number): ts.Node | undefined {
	let found: ts.Node | undefined;
	function visit(node: ts.Node): void {
		if (position < node.getStart(sourceFile) || position >= node.getEnd()) return;
		found = node;
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return found;
}

/**
 * The real, flow-sensitive type TypeScript's own checker resolves for the identifier at
 * `line`/`character` (1-indexed, matching WorkspaceLocation's own convention) in `path` -- built
 * on the same `typescript` npm package TypeScriptCompilerSymbolIndex already depends on for its
 * own structural fallback, but via a real `ts.Program` + `TypeChecker` rather than a bare
 * `ts.createSourceFile` parse: only a real Program has a binder-built control-flow graph (see
 * binder.ts's own FlowNode machinery, researched this session) for `getTypeAtLocation` to walk.
 *
 * Deliberately scoped to real, narrow, honest bounds: a single-file Program (no tsconfig
 * discovery, no full project module graph) is enough to exercise real intra-file flow narrowing
 * (an `if`/`typeof` guard, a reassignment) -- exactly the FlowNode-graph capability LSP itself
 * never exposes (tsserver builds this internally for every file it type-checks, but no LSP method
 * returns it). Cross-file type resolution is a real, known gap of this single-file scoping, not
 * attempted here -- an imported type resolves to whatever the compiler's own default module
 * resolution can find on disk, same as any other `ts.Program`, but this function makes no claim
 * about cross-file correctness the way CodeIntelligencePort's own LSP-backed queries can.
 *
 * Returns undefined when no identifier exists at the given position -- not every position is
 * inside a nameable expression -- and also when `line`/`character` doesn't even fall within the
 * file's own real bounds (e.g. a stale line/character pair from before an edit), rather than
 * letting TypeScript's own internal position-computation assertion crash the caller. Throws on a
 * genuinely missing/unreadable file, matching `readFileSync`'s own honest behavior rather than
 * degrading a real filesystem error to undefined.
 */
export async function narrowedTypeAtPosition(path: string, line: number, character: number): Promise<NarrowedType | undefined> {
	// Read once up front so createProgram's own default CompilerHost sees the exact bytes this
	// call was asked about, even if the file has been rewritten on disk between reads -- readFileSync
	// inside createProgram's default host would silently pick up whatever's on disk right now, a
	// TOCTOU distinct from what the caller's own line/character were computed against.
	const sourceText = readFileSync(path, "utf-8");
	const program = ts.createProgram({
		rootNames: [path],
		options: DEFAULT_COMPILER_OPTIONS,
		host: {
			...ts.createCompilerHost(DEFAULT_COMPILER_OPTIONS),
			readFile: (requestedPath) => (requestedPath === path ? sourceText : ts.sys.readFile(requestedPath)),
			fileExists: (requestedPath) => requestedPath === path || ts.sys.fileExists(requestedPath),
		},
	});
	const sourceFile = program.getSourceFile(path);
	if (!sourceFile) return undefined;
	if (!isWithinSourceFile(sourceFile, line, character)) return undefined;

	const position = sourceFile.getPositionOfLineAndCharacter(line - 1, character - 1);
	const node = nodeAtPosition(sourceFile, position);
	if (!node || !ts.isIdentifier(node)) return undefined;

	const checker = program.getTypeChecker();
	const narrowedType = checker.typeToString(checker.getTypeAtLocation(node));

	const symbol = checker.getSymbolAtLocation(node);
	const declarationSite = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
	// No resolvable declaration (e.g. a global, an ambient, an unresolved import) -- the position
	// at the reference itself is the only type this query can honestly report either way.
	const declaredType = declarationSite ? checker.typeToString(checker.getTypeAtLocation(declarationSite)) : narrowedType;

	return { declaredType, narrowedType, narrowed: declaredType !== narrowedType };
}
