import { describe, expect, it } from "bun:test";
import { resolveLspPlatform, UnsupportedLspPlatform } from "../../src/domain/lsp-platform.ts";

describe("resolveLspPlatform", () => {
	it("normalizes node's own platform/arch strings to the mason-shaped signature", () => {
		expect(resolveLspPlatform("linux", "x64", "glibc")).toEqual({ os: "linux", arch: "x64", libc: "glibc" });
		expect(resolveLspPlatform("linux", "arm64", "musl")).toEqual({ os: "linux", arch: "arm64", libc: "musl" });
		expect(resolveLspPlatform("darwin", "arm64", undefined)).toEqual({ os: "darwin", arch: "arm64", libc: undefined });
	});

	it("ignores a detected libc value on darwin/win32 -- the distinction is meaningless there", () => {
		expect(resolveLspPlatform("darwin", "x64", "glibc").libc).toBeUndefined();
		expect(resolveLspPlatform("win32", "x64", "glibc").libc).toBeUndefined();
	});

	it("normalizes node's ia32 to x86", () => {
		expect(resolveLspPlatform("linux", "ia32", undefined).arch).toBe("x86");
	});

	it("rejects an unsupported OS", () => {
		expect(() => resolveLspPlatform("aix" as NodeJS.Platform, "x64", undefined)).toThrow(UnsupportedLspPlatform);
	});

	it("rejects an unsupported architecture", () => {
		expect(() => resolveLspPlatform("linux", "mips", undefined)).toThrow(UnsupportedLspPlatform);
	});
});
