import { describe, expect, it } from "bun:test";
import { detectLibc } from "../../src/lsp-provisioning/detect-libc.ts";

function result(overrides: Partial<{ code: number | null; stdout: string; stderr: string }> = {}) {
	return { code: 0, signal: null, stdout: "", stderr: "", timedOut: false, ...overrides };
}

describe("detectLibc", () => {
	it("reports glibc when getconf GNU_LIBC_VERSION succeeds", async () => {
		const libc = await detectLibc(async (command) => (command === "getconf" ? result({ stdout: "glibc 2.35" }) : result({ code: 1 })));
		expect(libc).toBe("glibc");
	});

	it("falls back to ldd --version when getconf is unavailable, reporting musl", async () => {
		const libc = await detectLibc(async (command) => {
			if (command === "getconf") throw new Error("ENOENT");
			return result({ stdout: "musl libc (x86_64)\nVersion 1.2.3" });
		});
		expect(libc).toBe("musl");
	});

	it("falls back to ldd reporting glibc when its output mentions gnu/glibc instead", async () => {
		const libc = await detectLibc(async (command) => {
			if (command === "getconf") return result({ code: 1 });
			return result({ stdout: "ldd (GNU libc) 2.35" });
		});
		expect(libc).toBe("glibc");
	});

	it("returns undefined when both checks are inconclusive, never throwing", async () => {
		const libc = await detectLibc(async () => {
			throw new Error("ENOENT");
		});
		expect(libc).toBeUndefined();
	});
});
