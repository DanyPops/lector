import type { LibcVariant } from "../domain/lsp-platform.ts";
import { type BoundedSubprocessResult, runBoundedSubprocess } from "./bounded-subprocess.ts";

const DETECT_TIMEOUT_MS = 2000;

type SubprocessRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<BoundedSubprocessResult>;

const defaultRunner: SubprocessRunner = (command, args, timeoutMs) => runBoundedSubprocess(command, args, { timeoutMs });

/**
 * Detects glibc vs musl on Linux the same way mason.nvim does: `getconf GNU_LIBC_VERSION`
 * succeeds only on glibc; `ldd --version`'s output mentions "musl" on a musl system (Alpine and
 * similar). Bounded and best-effort -- undefined (not a thrown error) when neither check is
 * conclusive, since libc detection is itself an enhancement (GitHub-release asset matching), not
 * something provisioning should ever fail outright over. `run` is injected (real detection shells
 * out) so every branch is testable without depending on the real test host's own libc.
 */
export async function detectLibc(run: SubprocessRunner = defaultRunner): Promise<LibcVariant | undefined> {
	try {
		const getconf = await run("getconf", ["GNU_LIBC_VERSION"], DETECT_TIMEOUT_MS);
		if (getconf.code === 0 && getconf.stdout.toLowerCase().includes("glibc")) return "glibc";
	} catch {
		// getconf not on PATH -- fall through to ldd.
	}
	try {
		const ldd = await run("ldd", ["--version"], DETECT_TIMEOUT_MS);
		const combined = `${ldd.stdout}${ldd.stderr}`.toLowerCase();
		if (combined.includes("musl")) return "musl";
		if (combined.includes("glibc") || combined.includes("gnu")) return "glibc";
	} catch {
		// ldd not on PATH either -- genuinely inconclusive.
	}
	return undefined;
}
