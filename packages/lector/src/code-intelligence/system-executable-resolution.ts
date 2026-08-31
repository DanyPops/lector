import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const DEFAULT_LOGIN_SHELL_TIMEOUT_MS = 2_000;
const MAX_LOGIN_SHELL_OUTPUT_BYTES = 4_096;

export type SystemExecutableResolution =
	| { readonly status: "resolved"; readonly path: string; readonly source: "override" | "process-path" | "login-shell" | "go-toolchain" }
	| { readonly status: "unavailable"; readonly overrideEnvironmentVariable?: string };

export interface SystemExecutableResolutionOptions {
	readonly overrideEnvironmentVariable?: string;
	readonly environment?: NodeJS.ProcessEnv;
	readonly loginShellTimeoutMs?: number;
	readonly toolchainExecutableDiscovery?: "go";
}

function executablePath(candidate: string | undefined): string | undefined {
	if (!candidate || !isAbsolute(candidate)) return undefined;
	try {
		accessSync(candidate, constants.X_OK);
		return realpathSync(candidate);
	} catch {
		return undefined;
	}
}

function loginShellExecutable(command: string, environment: NodeJS.ProcessEnv, timeoutMs: number): string | undefined {
	const shell = executablePath(environment.SHELL) ?? "/bin/sh";
	try {
		const output = execFileSync(shell, ["-lc", 'command -v "$1"', "lector-resolve-executable", command], {
			env: environment,
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: MAX_LOGIN_SHELL_OUTPUT_BYTES,
			stdio: ["ignore", "pipe", "ignore"],
		});
		return executablePath(output.trim().split("\n", 1)[0]);
	} catch {
		return undefined;
	}
}

function goToolchainExecutable(command: string, environment: NodeJS.ProcessEnv, timeoutMs: number): string | undefined {
	const go = Bun.which("go", { PATH: environment.PATH }) ?? loginShellExecutable("go", environment, timeoutMs);
	if (!go) return undefined;
	try {
		const output = execFileSync(go, ["env", "GOBIN", "GOPATH"], {
			env: environment,
			encoding: "utf8",
			timeout: timeoutMs,
			maxBuffer: MAX_LOGIN_SHELL_OUTPUT_BYTES,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const [goBin, goPath] = output.trimEnd().split("\n", 2);
		const binDirectory =
			typeof goBin === "string" && goBin.length > 0 ? goBin : typeof goPath === "string" && goPath.length > 0 ? join(goPath, "bin") : undefined;
		return binDirectory ? executablePath(join(binDirectory, command)) : undefined;
	} catch {
		return undefined;
	}
}

/** Resolves a system executable through explicit configuration, the process PATH, then a bounded login shell. */
export function resolveSystemExecutable(command: string, options: SystemExecutableResolutionOptions = {}): SystemExecutableResolution {
	const environment = options.environment ?? process.env;
	const override = options.overrideEnvironmentVariable ? environment[options.overrideEnvironmentVariable] : undefined;
	if (override !== undefined) {
		const path = executablePath(override);
		return path
			? { status: "resolved", path, source: "override" }
			: { status: "unavailable", overrideEnvironmentVariable: options.overrideEnvironmentVariable };
	}

	const processPath = Bun.which(command, { PATH: environment.PATH });
	if (processPath) return { status: "resolved", path: realpathSync(processPath), source: "process-path" };

	const timeoutMs = options.loginShellTimeoutMs ?? DEFAULT_LOGIN_SHELL_TIMEOUT_MS;
	if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("loginShellTimeoutMs must be a positive safe integer");
	const loginShellPath = loginShellExecutable(command, environment, timeoutMs);
	if (loginShellPath) return { status: "resolved", path: loginShellPath, source: "login-shell" };
	const toolchainPath = options.toolchainExecutableDiscovery === "go" ? goToolchainExecutable(command, environment, timeoutMs) : undefined;
	return toolchainPath
		? { status: "resolved", path: toolchainPath, source: "go-toolchain" }
		: { status: "unavailable", ...(options.overrideEnvironmentVariable ? { overrideEnvironmentVariable: options.overrideEnvironmentVariable } : {}) };
}
