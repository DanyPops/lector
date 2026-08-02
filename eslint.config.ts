import importX from "eslint-plugin-import-x";
import tseslint from "typescript-eslint";

const PRODUCTION_SOURCE = ["packages/*/src/**/*.ts", "packages/*/extension/src/**/*.ts"];

export default tseslint.config(
	{ ignores: ["**/node_modules/**", "**/dist/**", "**/*.d.ts"] },

	// Import-cycle detection: a hexagonal core with domain/ports/adapters/service layers
	// is exactly the shape that silently grows cycles if nothing catches them early.
	// silently grows cycles if nothing catches them early.
	{
		files: PRODUCTION_SOURCE,
		plugins: { "import-x": importX },
		settings: {
			"import-x/resolver": { typescript: true },
		},
		rules: {
			"import-x/no-cycle": ["error", { ignoreExternal: true }],
		},
	},

	// Type-aware safety rules, production source only -- test fixtures intentionally
	// exercise loosely-typed payloads (e.g. raw JSON-RPC responses) that would fight
	// these rules for no real safety gain.
	{
		files: PRODUCTION_SOURCE,
		extends: [...tseslint.configs.recommendedTypeChecked],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Keeps a package's own internal modules importing each other directly rather
			// than through its own public barrel -- ./index.ts is for external consumers.
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: ["../index", "../index.js", "../../index", "../../index.js"],
							message: "Do not import from barrel files (index.ts) within a package's own source. Import from the source module directly.",
						},
					],
				},
			],

			"no-void": ["error", { allowAsStatement: true }],

			"@typescript-eslint/no-unsafe-member-access": "error",
			"@typescript-eslint/no-unsafe-argument": "error",
			"@typescript-eslint/no-unsafe-return": "error",
			"@typescript-eslint/no-unsafe-assignment": "error",
			"@typescript-eslint/no-unsafe-call": "error",
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/use-unknown-in-catch-callback-variable": "error",
			"@typescript-eslint/no-explicit-any": "error",
			"@typescript-eslint/no-unsafe-type-assertion": "error",
			"@typescript-eslint/no-unsafe-enum-comparison": "error",
			"@typescript-eslint/no-mixed-enums": "error",
			"@typescript-eslint/prefer-nullish-coalescing": "error",
			"@typescript-eslint/no-unnecessary-condition": "error",
			"@typescript-eslint/no-namespace": "error",
			"@typescript-eslint/no-base-to-string": "error",
			"@typescript-eslint/no-unused-vars": ["error", { varsIgnorePattern: "^_", argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
			"@typescript-eslint/consistent-type-assertions": ["error", { assertionStyle: "as", objectLiteralTypeAssertions: "allow-as-parameter" }],
			"@typescript-eslint/consistent-type-imports": ["error", { prefer: "type-imports", fixStyle: "inline-type-imports" }],
			"@typescript-eslint/no-import-type-side-effects": "error",
			"@typescript-eslint/no-unnecessary-type-assertion": "error",
			"@typescript-eslint/prefer-promise-reject-errors": "error",

			// Relaxed: intentional patterns already in use.
			"@typescript-eslint/no-empty-object-type": "off",
			"@typescript-eslint/unbound-method": "off",
			"@typescript-eslint/no-redundant-type-constituents": "off",
			// Ports (SymbolGraphPort, ContentCachePort, SearchCachePort, SymbolAnnotationPort,
			// WorkspacePort) are correctly async for backends that genuinely need it (LSP, network);
			// the in-memory/sqlite adapters and service.ts's operation handlers share that contract
			// while wrapping synchronous work. Confirmed real across 15+ call sites, not a one-off.
			"@typescript-eslint/require-await": "off",
		},
	},

	// better-sqlite3's .get()/.all() return untyped rows by design -- each of these adapters'
	// whole job is casting a row to the domain shape of a schema it also owns and migrates itself.
	{
		files: [
			"packages/lector/src/content-cache/sqlite-content-cache.ts",
			"packages/lector/src/search-cache/sqlite-search-cache.ts",
			"packages/lector/src/adapters/sqlite-symbol-annotations.ts",
			"packages/lector/src/symbol-graph/sqlite-symbol-graph.ts",
		],
		rules: {
			"@typescript-eslint/no-unsafe-type-assertion": "off",
		},
	},

	// Ports-and-adapters dependency direction: domain and ports define the core's own
	// language and must stay adapter-agnostic; only adapters/service/daemon/cli/client may
	// depend inward on a concrete adapter.
	{
		files: ["packages/lector/src/domain/**/*.ts", "packages/lector/src/ports/**/*.ts"],
		rules: {
			"no-restricted-imports": [
				"error",
				{
					patterns: [
						{
							group: ["**/adapters/*", "**/adapters/**"],
							message: "domain/ports must not import adapters -- the dependency direction runs the other way in a hexagonal core.",
						},
					],
				},
			],
		},
	},
);
