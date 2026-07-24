/**
 * Everything needed to spawn and address one language's LSP server: how to
 * launch it, which files it applies to, and which directory marks a real
 * project root for it. This exact shape (command/args/extensions/root
 * markers/extra capabilities) is independently converged on by nvim-
 * lspconfig, mason-registry, and multiple real Pi LSP extensions
 * (@dreki-gg/pi-lsp, @narumitw/pi-lsp, @arvoretech/pi-lsp) -- not invented
 * here.
 */

/** An npm-module server resolves its JS entry via import.meta.resolve and runs under bun; a system-binary server (gopls, rust-analyzer, clangd) resolves by bare name against PATH. */
export type LanguageServerLaunch = { readonly kind: "npm-module"; readonly entryModule: string } | { readonly kind: "system-binary"; readonly command: string };

export interface LanguageServerDescriptor {
	readonly languageId: string;
	readonly extensions: readonly string[];
	readonly launch: LanguageServerLaunch;
	readonly args: readonly string[];
	/** Checked nearest-first; closest match wins over a more distant one -- a monorepo subproject with its own root marker resolves to itself, not the outer repo. */
	readonly rootMarkers: readonly string[];
	/** Tried before the bounded directory scan when picking a file to warm the server with (e.g. a language's usual entry-point names). */
	readonly commonSeedCandidates: readonly string[];
	/** Extra textDocument/workspace capabilities this specific server gates real features behind (e.g. typescript-language-server withholds diagnostics/callHierarchy unless declared). */
	readonly extraCapabilities?: Record<string, unknown>;
	/** Milliseconds to wait after opening a file before trusting the server's answers -- no server signals "project loaded". Default 1000ms; rust-analyzer needs more (see RUST_DESCRIPTOR). */
	readonly settleMs?: number;
}

export const DEFAULT_SETTLE_MS = 1000;

export const TYPESCRIPT_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "typescript",
	extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
	launch: { kind: "npm-module", entryModule: "typescript-language-server/lib/cli.mjs" },
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
	launch: { kind: "npm-module", entryModule: "pyright/langserver.index.js" },
	args: ["--stdio"],
	rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
	commonSeedCandidates: ["main.py", "src/main.py", "__init__.py", "src/__init__.py"],
};

export const GO_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "go",
	extensions: [".go"],
	// gopls ships via `go install`, not npm.
	launch: { kind: "system-binary", command: "gopls" },
	args: ["serve"],
	rootMarkers: ["go.mod", "go.work"],
	commonSeedCandidates: ["main.go", "cmd/main.go"],
};

export const RUST_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "rust",
	extensions: [".rs"],
	// rust-analyzer ships via rustup, not npm.
	launch: { kind: "system-binary", command: "rust-analyzer" },
	args: [],
	rootMarkers: ["Cargo.toml"],
	commonSeedCandidates: ["src/main.rs", "src/lib.rs"],
	// A query under ~800ms after didOpen can return a null result; 2500ms holds a real margin.
	settleMs: 2500,
};

export const CPP_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "cpp",
	extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
	// clangd ships via LLVM's system packaging, not npm.
	launch: { kind: "system-binary", command: "clangd" },
	args: [],
	rootMarkers: ["compile_commands.json", "compile_flags.txt", "CMakeLists.txt"],
	commonSeedCandidates: ["main.cpp", "main.c", "src/main.cpp", "src/main.c"],
};

export const BASH_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "shellscript",
	extensions: [".sh", ".bash"],
	launch: { kind: "npm-module", entryModule: "bash-language-server/out/cli.js" },
	args: ["start"],
	rootMarkers: [],
	commonSeedCandidates: ["main.sh", "run.sh", "install.sh"],
};

export const YAML_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "yaml",
	extensions: [".yaml", ".yml"],
	launch: { kind: "npm-module", entryModule: "yaml-language-server/bin/yaml-language-server" },
	args: ["--stdio"],
	rootMarkers: [],
	commonSeedCandidates: [],
};

/** Every known descriptor, in priority order for ambiguous-extension lookups. */
export const LANGUAGE_SERVER_DESCRIPTORS: readonly LanguageServerDescriptor[] = [
	TYPESCRIPT_DESCRIPTOR,
	PYTHON_DESCRIPTOR,
	GO_DESCRIPTOR,
	RUST_DESCRIPTOR,
	CPP_DESCRIPTOR,
	BASH_DESCRIPTOR,
	YAML_DESCRIPTOR,
];

/** The first descriptor whose extensions list includes `extension` (leading dot, e.g. ".py"), or undefined if none match. */
export function descriptorForExtension(extension: string): LanguageServerDescriptor | undefined {
	return LANGUAGE_SERVER_DESCRIPTORS.find((descriptor) => descriptor.extensions.includes(extension));
}
