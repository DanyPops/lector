import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync, readlinkSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { RUST_DESCRIPTOR } from "../../src/code-intelligence/language-server-descriptor.ts";
import { LspSymbolIndex } from "../../src/code-intelligence/lsp/lsp-symbol-index.ts";
import { contentHashOf } from "../../src/content-identity/content-hash.ts";

const root = process.env.LECTOR_DIAGNOSTIC_REFERENCE_ROOT;
const source = process.env.LECTOR_DIAGNOSTIC_REFERENCE_FILE;
const evidence = process.env.LECTOR_DIAGNOSTIC_REFERENCE_EVIDENCE;
const analyzer = process.env.LECTOR_DIAGNOSTIC_REFERENCE_ANALYZER;

it.skipIf(!root || !source || !evidence)(
	"compares configured Rust source with compiler evidence",
	async () => {
		if (!root || !source || !evidence) throw new Error("reference root, source and evidence path are required");
		const environmentPid = process.env.LECTOR_DIAGNOSTIC_REFERENCE_ENV_PID;
		if (environmentPid) {
			if (!/^[1-9][0-9]{0,9}$/.test(environmentPid)) throw new Error("invalid reference environment PID");
			const descriptor = openSync(`/proc/${environmentPid}/environ`, "r");
			const buffer = Buffer.alloc(1024 * 1024 + 1);
			let length: number;
			try {
				length = readSync(descriptor, buffer, 0, buffer.length, 0);
			} finally {
				closeSync(descriptor);
			}
			if (length > 1024 * 1024) throw new Error("reference environment exceeds 1 MiB");
			const selected = [
				"PATH",
				"HOME",
				"RUSTUP_HOME",
				"RUSTUP_TOOLCHAIN",
				"CARGO_HOME",
				"RUST_SRC_PATH",
				"RUSTFLAGS",
				"CARGO_ENCODED_RUSTFLAGS",
				"CARGO_BUILD_TARGET",
				"CARGO_TARGET_DIR",
			];
			const environment = { ...process.env };
			for (const key of selected) delete environment[key];
			for (const entry of buffer.toString("utf8", 0, length).split("\0")) {
				const separator = entry.indexOf("=");
				const key = entry.slice(0, separator);
				if (selected.includes(key)) environment[key] = entry.slice(separator + 1);
			}
			buffer.fill(0);
			delete environment.LECTOR_DIAGNOSTIC_REFERENCE_ENV_PID;
			execFileSync(process.execPath, ["test", import.meta.path], { env: environment, timeout: 180_000, maxBuffer: 262_144, stdio: ["ignore", "pipe", "pipe"] });
			return;
		}
		const path = resolve(root, source);
		expect(statSync(path).size).toBeLessThan(4 * 1024 * 1024);
		const content = readFileSync(path, "utf8");
		const hash = contentHashOf(content);
		const manifest = join(dirname(dirname(path)), "Cargo.toml");
		const target = basename(path, ".rs");
		const run = (command: string, args: string[], timeout = 10_000) =>
			execFileSync(command, args, { cwd: root, encoding: "utf8", timeout, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
		const compilerArgs = ["test", "--locked", "--offline", "--manifest-path", manifest, "--test", target];
		const compilerOutput = run("cargo", compilerArgs, 120_000);
		const sysroot = run("rustc", ["--print", "sysroot"]);
		const index = new LspSymbolIndex(root, analyzer ? { ...RUST_DESCRIPTOR, launch: { kind: "system-binary", command: analyzer } } : RUST_DESCRIPTOR, source);
		try {
			const initialDiagnostics = await index.diagnostics(path);
			const initialContext = index.diagnosticContext(path);
			const quiescent = await index.waitForProjectQuiescence(120_000);
			const diagnostics = quiescent ? await index.diagnostics(path) : initialDiagnostics;
			const context = index.diagnosticContext(path);
			const executable = index.processId !== undefined && process.platform === "linux" ? readlinkSync(`/proc/${index.processId}/exe`) : undefined;
			writeFileSync(
				evidence,
				JSON.stringify(
					{
						revision: run("git", ["rev-parse", "HEAD"]),
						source: relative(root, path),
						sourceHash: hash,
						registeredRoot: root,
						compilerSysroot: sysroot,
						compiler: run("rustc", ["-vV"]),
						analyzer: executable ? run(executable, ["--version"]) : "unreported",
						compilerArgs: compilerArgs.map((argument) => (argument === manifest ? relative(root, manifest) : argument)),
						compilerPassed: true,
						compilerOutput: compilerOutput.slice(0, 16_384),
						standardLibrarySourcesPresent: existsSync(join(sysroot, "lib/rustlib/src/rust/library/core/src/lib.rs")),
						analyzerConfiguration: {
							initializationOptions: {},
							workspaceConfiguration: null,
							cargoFeatures: "unreported",
							buildScripts: "unreported",
							procMacros: "unreported",
						},
						initialContext,
						quiescent,
						context,
						diagnostics: diagnostics
							.slice(0, 200)
							.map((diagnostic) => ({ ...diagnostic, range: { ...diagnostic.range, path: relative(root, diagnostic.range.path) } })),
						diagnosticsTruncated: diagnostics.length > 200,
					},
					null,
					2,
				),
			);
			const expected = process.env.LECTOR_DIAGNOSTIC_REFERENCE_EXPECT;
			if (expected === "standard-library") {
				expect(context.confidence).toBe("degraded");
				expect(context.setupFindings.some(({ kind }) => kind === "standard-library")).toBe(true);
				expect(diagnostics.some(({ severity }) => severity === "error")).toBe(true);
			} else if (expected === "healthy") {
				expect(context.confidence).toBe("reported-ready");
				expect(diagnostics.filter(({ severity }) => severity === "error")).toEqual([]);
			} else if (expected !== undefined) throw new Error("reference expectation must be healthy or standard-library");
			expect(context.document.synchronizedContentHash).toBe(hash);
			expect(contentHashOf(readFileSync(path, "utf8"))).toBe(hash);
			expect(compilerOutput).toContain("0 failed");
		} finally {
			await index.close();
		}
	},
	180_000,
);
