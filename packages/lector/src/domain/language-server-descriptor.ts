/**
 * Everything needed to spawn and address one language's LSP server: how to
 * launch it, which files it applies to, and which directory marks a real
 * project root for it. This exact shape (command/args/extensions/root
 * markers/extra capabilities) is independently converged on by nvim-
 * lspconfig, mason-registry, and multiple real Pi LSP extensions
 * (@dreki-gg/pi-lsp, @narumitw/pi-lsp, @arvoretech/pi-lsp) -- not invented
 * here.
 */
export interface LanguageServerDescriptor {
	readonly languageId: string;
	readonly extensions: readonly string[];
	/** npm-package-relative path to the server's JS entry point, resolved via import.meta.resolve and spawned as `bun <resolved-path> <args>` -- a bare PATH-based command name is not reliably resolvable against a package installed as Lector's own devDependency rather than the target workspace's. */
	readonly entryModule: string;
	readonly args: readonly string[];
	/** Checked nearest-first; closest match wins over a more distant one -- a monorepo subproject with its own root marker resolves to itself, not the outer repo. */
	readonly rootMarkers: readonly string[];
	/** Tried before the bounded directory scan when picking a file to warm the server with (e.g. a language's usual entry-point names). */
	readonly commonSeedCandidates: readonly string[];
	/** Extra textDocument/workspace capabilities this specific server gates real features behind (e.g. typescript-language-server withholds diagnostics/callHierarchy unless declared). */
	readonly extraCapabilities?: Record<string, unknown>;
}

export const TYPESCRIPT_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "typescript",
	extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
	entryModule: "typescript-language-server/lib/cli.mjs",
	args: ["--stdio"],
	rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
	commonSeedCandidates: ["src/index.ts", "index.ts", "src/main.ts", "main.ts", "src/index.tsx", "index.tsx", "src/index.js", "index.js"],
	// typescript-language-server gates its own diagnosticsSupport/callHierarchyProvider flags
	// on these capabilities being present at all -- omitted, it silently withholds both.
	extraCapabilities: { publishDiagnostics: {}, callHierarchy: {} },
};

export const PYTHON_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "python",
	extensions: [".py", ".pyi"],
	entryModule: "pyright/langserver.index.js",
	args: ["--stdio"],
	rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
	commonSeedCandidates: ["main.py", "src/main.py", "__init__.py", "src/__init__.py"],
};

/** Every known descriptor, in priority order for ambiguous-extension lookups. */
export const LANGUAGE_SERVER_DESCRIPTORS: readonly LanguageServerDescriptor[] = [TYPESCRIPT_DESCRIPTOR, PYTHON_DESCRIPTOR];

/** The first descriptor whose extensions list includes `extension` (leading dot, e.g. ".py"), or undefined if none match. */
export function descriptorForExtension(extension: string): LanguageServerDescriptor | undefined {
	return LANGUAGE_SERVER_DESCRIPTORS.find((descriptor) => descriptor.extensions.includes(extension));
}
