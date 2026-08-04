/**
 * Everything needed to spawn and address one language's LSP server: how to
 * launch it, which files it applies to, and which directory marks a real
 * project root for it. This exact shape (command/args/extensions/root
 * markers/extra capabilities) is independently converged on by nvim-
 * lspconfig, mason-registry, and multiple real Pi LSP extensions
 * (@dreki-gg/pi-lsp, @narumitw/pi-lsp, @arvoretech/pi-lsp) -- not invented
 * here.
 */

import type { LanguageServerSource } from "./language-server-package-spec.ts";

/** An npm-module server resolves its JS entry via import.meta.resolve and runs under bun; a system-binary server (gopls, rust-analyzer, clangd) resolves by bare name against PATH. */
export type LanguageServerLaunch = { readonly kind: "npm-module"; readonly entryModule: string } | { readonly kind: "system-binary"; readonly command: string };

export interface LanguageServerDescriptor {
	readonly languageId: string;
	readonly backendId: string;
	readonly extensions: readonly string[];
	/** Per-extension document language ids when one server owns a language family. */
	readonly documentLanguageIds?: Readonly<Record<string, string>>;
	readonly launch: LanguageServerLaunch;
	/** Optional managed source used only after a system-binary spawn fails with ENOENT. */
	readonly provisioning?: LanguageServerSource;
	readonly args: readonly string[];
	/** Checked nearest-first; closest match wins over a more distant one -- a monorepo subproject with its own root marker resolves to itself, not the outer repo. */
	readonly rootMarkers: readonly string[];
	/** Tried before the bounded directory scan when picking a file to warm the server with (e.g. a language's usual entry-point names). */
	readonly commonSeedCandidates: readonly string[];
	/** Excludes unsafe or unusually expensive servers from automatic workspace-wide fan-out while preserving explicit file operations. */
	readonly workspaceDiscovery?: "enabled" | "explicit-only";
	/** Extra textDocument/workspace capabilities this specific server gates real features behind (e.g. typescript-language-server withholds diagnostics/callHierarchy unless declared). */
	readonly extraCapabilities?: Record<string, unknown>;
	/** Milliseconds to wait after opening a file before trusting the server's answers -- no server signals "project loaded". Default 1000ms; rust-analyzer needs more (see RUST_DESCRIPTOR). */
	readonly settleMs?: number;
}

export const DEFAULT_SETTLE_MS = 1000;

export const TYPESCRIPT_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "typescript",
	backendId: "typescript-language-server",
	extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
	documentLanguageIds: {
		".ts": "typescript",
		".tsx": "typescriptreact",
		".js": "javascript",
		".jsx": "javascriptreact",
		".mjs": "javascript",
		".cjs": "javascript",
	},
	launch: { kind: "npm-module", entryModule: "typescript-language-server/lib/cli.mjs" },
	args: ["--stdio"],
	rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
	commonSeedCandidates: ["src/index.ts", "index.ts", "src/main.ts", "main.ts", "src/index.tsx", "index.tsx", "src/index.js", "index.js"],
	settleMs: 2000,
	// typescript-language-server gates its own diagnosticsSupport/callHierarchyProvider flags
	// on these capabilities being present at all -- omitted, it silently withholds both.
	extraCapabilities: { publishDiagnostics: {}, callHierarchy: {} },
};

export const PYTHON_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "python",
	backendId: "pyright",
	extensions: [".py", ".pyi"],
	launch: { kind: "npm-module", entryModule: "pyright/langserver.index.js" },
	args: ["--stdio"],
	rootMarkers: ["pyrightconfig.json", "pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "Pipfile"],
	commonSeedCandidates: ["main.py", "src/main.py", "__init__.py", "src/__init__.py"],
};

export const GO_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "go",
	backendId: "gopls",
	extensions: [".go"],
	// gopls ships via `go install`, not npm.
	launch: { kind: "system-binary", command: "gopls" },
	args: ["serve"],
	rootMarkers: ["go.mod", "go.work"],
	commonSeedCandidates: ["main.go", "cmd/main.go"],
};

export const RUST_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "rust",
	backendId: "rust-analyzer",
	extensions: [".rs"],
	launch: { kind: "system-binary", command: "rust-analyzer" },
	provisioning: {
		kind: "github-release",
		repo: "rust-lang/rust-analyzer",
		assetName: (platform) => {
			if (platform.os === "darwin" && (platform.arch === "x64" || platform.arch === "arm64")) {
				return `rust-analyzer-${platform.arch === "x64" ? "x86_64" : "aarch64"}-apple-darwin.gz`;
			}
			if (platform.os === "linux" && platform.arch === "x64" && platform.libc) {
				return `rust-analyzer-x86_64-unknown-linux-${platform.libc === "musl" ? "musl" : "gnu"}.gz`;
			}
			if (platform.os === "linux" && platform.arch === "arm64" && platform.libc === "glibc") {
				return "rust-analyzer-aarch64-unknown-linux-gnu.gz";
			}
			if (platform.os === "linux" && platform.arch === "arm" && platform.libc === "glibc") {
				return "rust-analyzer-arm-unknown-linux-gnueabihf.gz";
			}
			if (platform.os === "win32" && (platform.arch === "x64" || platform.arch === "x86" || platform.arch === "arm64")) {
				const arch = platform.arch === "x64" ? "x86_64" : platform.arch === "x86" ? "i686" : "aarch64";
				return `rust-analyzer-${arch}-pc-windows-msvc.zip`;
			}
			return undefined;
		},
		binPathInArchive: (platform) => `rust-analyzer${platform.os === "win32" ? ".exe" : ""}`,
	},
	args: [],
	rootMarkers: ["Cargo.toml"],
	commonSeedCandidates: ["src/main.rs", "src/lib.rs"],
	settleMs: 5000,
};

export const CPP_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "cpp",
	backendId: "clangd",
	extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"],
	launch: { kind: "system-binary", command: "clangd" },
	provisioning: {
		kind: "github-release",
		repo: "clangd/clangd",
		assetName: (platform, releaseTag) => {
			if (platform.os === "linux" && platform.arch === "x64" && platform.libc === "glibc") return `clangd-linux-${releaseTag}.zip`;
			if (platform.os === "darwin" && (platform.arch === "x64" || platform.arch === "arm64")) return `clangd-mac-${releaseTag}.zip`;
			if (platform.os === "win32" && platform.arch === "x64") return `clangd-windows-${releaseTag}.zip`;
			return undefined;
		},
		binPathInArchive: (platform, releaseTag) => `clangd_${releaseTag}/bin/clangd${platform.os === "win32" ? ".exe" : ""}`,
	},
	args: [],
	rootMarkers: ["compile_commands.json", "compile_flags.txt", "CMakeLists.txt"],
	commonSeedCandidates: ["main.cpp", "main.c", "src/main.cpp", "src/main.c"],
};

export const BASH_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "shellscript",
	backendId: "bash-language-server",
	extensions: [".sh", ".bash"],
	workspaceDiscovery: "explicit-only",
	// System-binary, not npm-module: bash-language-server's own package.json hard-pins a vulnerable
	// editorconfig -> minimatch/brace-expansion chain (GHSA-3ppc-4f35-3m26, GHSA-7r86-cg39-jmmj,
	// GHSA-23c5-xmqv-rm74, GHSA-mh99-v99m-4gvg) with no upstream fix. That chain is only reachable
	// through textDocument/formatting, which Lector never sends -- but bundling it as a production
	// npm dependency still ships the vulnerable code and the audit finding to every consumer.
	// PATH-only launch keeps Bash support available to users who install it themselves without
	// shipping or managed-provisioning the vulnerable package by default.
	launch: { kind: "system-binary", command: "bash-language-server" },
	args: ["start"],
	rootMarkers: [],
	commonSeedCandidates: ["main.sh", "run.sh", "install.sh"],
};

export const YAML_DESCRIPTOR: LanguageServerDescriptor = {
	languageId: "yaml",
	backendId: "yaml-language-server",
	extensions: [".yaml", ".yml"],
	workspaceDiscovery: "explicit-only",
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

/** The descriptor for a file's own extension, e.g. ".py" -> Python. */
export function descriptorForPath(path: string): LanguageServerDescriptor | undefined {
	const dot = path.lastIndexOf(".");
	return dot === -1 ? undefined : descriptorForExtension(path.slice(dot));
}
