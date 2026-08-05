/**
 * Registers every non-TypeScript LanguageServerDescriptor against the shared
 * conformance suite. TypeScript itself is covered by lsp-symbol-index.test.ts,
 * which dogfoods Lector's own source tree instead of a synthetic fixture.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BASH_DESCRIPTOR,
	CPP_DESCRIPTOR,
	GO_DESCRIPTOR,
	PYTHON_DESCRIPTOR,
	RUST_DESCRIPTOR,
	YAML_DESCRIPTOR,
} from "../../../src/code-intelligence/language-server-descriptor.ts";
import { runLanguageServerConformanceSuite } from "../../support/language-server-conformance.ts";

runLanguageServerConformanceSuite({
	languageName: "Python",
	descriptor: PYTHON_DESCRIPTOR,
	seedFile: "main.py",
	buildRoot: () => {
		const root = mkdtempSync(join(tmpdir(), "lector-python-fixture-"));
		writeFileSync(
			join(root, "main.py"),
			"def add(a: int, b: int) -> int:\n    return a + b\n\n\ndef add_twice(a: int, b: int) -> int:\n    return add(a, b) + add(a, b)\n",
		);
		return root;
	},
	mainFile: (root) => join(root, "main.py"),
	expectedSymbolNames: ["add", "add_twice"],
	callUsage: { substring: "return add(a, b) + add(a, b)", offsetWithinSubstring: "return ".length },
	expectedMaxRssMb: 400,
});

runLanguageServerConformanceSuite({
	languageName: "Go",
	descriptor: GO_DESCRIPTOR,
	seedFile: "main.go",
	buildRoot: () => {
		const root = mkdtempSync(join(tmpdir(), "lector-go-fixture-"));
		writeFileSync(join(root, "go.mod"), "module fixture\n\ngo 1.22\n");
		writeFileSync(
			join(root, "main.go"),
			"package main\n\nfunc add(a int, b int) int {\n\treturn a + b\n}\n\nfunc addTwice(a int, b int) int {\n\treturn add(a, b) + add(a, b)\n}\n",
		);
		return root;
	},
	mainFile: (root) => join(root, "main.go"),
	expectedSymbolNames: ["add", "addTwice"],
	callUsage: { substring: "return add(a, b) + add(a, b)", offsetWithinSubstring: "return ".length },
	expectedMaxRssMb: 700,
});

runLanguageServerConformanceSuite({
	languageName: "Rust",
	descriptor: RUST_DESCRIPTOR,
	seedFile: "src/main.rs",
	buildRoot: () => {
		const root = mkdtempSync(join(tmpdir(), "lector-rust-fixture-"));
		writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "fixture"\nversion = "0.1.0"\nedition = "2021"\n');
		mkdirSync(join(root, "src"));
		writeFileSync(
			join(root, "src", "main.rs"),
			'fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\nfn add_twice(a: i32, b: i32) -> i32 {\n    add(a, b) + add(a, b)\n}\n\nfn main() {\n    println!("{}", add_twice(1, 2));\n}\n',
		);
		return root;
	},
	mainFile: (root) => join(root, "src", "main.rs"),
	expectedSymbolNames: ["add", "add_twice"],
	callUsage: { substring: "add(a, b) + add(a, b)", offsetWithinSubstring: 1 },
	timeoutMs: 30_000,
	expectedMaxRssMb: 900,
});

runLanguageServerConformanceSuite({
	languageName: "C++",
	descriptor: CPP_DESCRIPTOR,
	seedFile: "main.cpp",
	buildRoot: () => {
		const root = mkdtempSync(join(tmpdir(), "lector-cpp-fixture-"));
		writeFileSync(
			join(root, "main.cpp"),
			"int add(int a, int b) {\n    return a + b;\n}\n\nint add_twice(int a, int b) {\n    return add(a, b) + add(a, b);\n}\n\nint main() {\n    return add_twice(1, 2);\n}\n",
		);
		return root;
	},
	mainFile: (root) => join(root, "main.cpp"),
	expectedSymbolNames: ["add", "add_twice", "main"],
	callUsage: { substring: "return add(a, b) + add(a, b)", offsetWithinSubstring: "return ".length },
	expectedMaxRssMb: 400,
});

runLanguageServerConformanceSuite({
	languageName: "Bash",
	descriptor: BASH_DESCRIPTOR,
	seedFile: "main.sh",
	buildRoot: () => {
		const root = mkdtempSync(join(tmpdir(), "lector-bash-fixture-"));
		writeFileSync(join(root, "main.sh"), "add() {\n    echo $(( $1 + $2 ))\n}\n\nadd_twice() {\n    add 1 2\n    add 1 2\n}\n");
		return root;
	},
	mainFile: (root) => join(root, "main.sh"),
	expectedSymbolNames: ["add", "add_twice"],
	callUsage: { substring: "    add 1 2", offsetWithinSubstring: 4 },
	expectedMaxRssMb: 300,
});

runLanguageServerConformanceSuite({
	languageName: "YAML",
	descriptor: YAML_DESCRIPTOR,
	seedFile: "config.yaml",
	buildRoot: () => {
		const root = mkdtempSync(join(tmpdir(), "lector-yaml-fixture-"));
		writeFileSync(join(root, "config.yaml"), "name: fixture\nversion: 1\nitems:\n  - one\n  - two\n");
		return root;
	},
	mainFile: (root) => join(root, "config.yaml"),
	expectedSymbolNames: ["name", "version", "items"],
	// YAML keys are not callable -- goToDefinition has no meaningful target to assert here.
	expectedMaxRssMb: 300,
	// yaml-language-server declares no workspaceSymbolProvider capability at all -- confirmed
	// absent from its own bundled source, not a timing issue.
	supportsFindWorkspaceSymbols: false,
});
