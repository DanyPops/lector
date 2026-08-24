import { describe, expect, it } from "bun:test";
import {
	BASH_DESCRIPTOR,
	CPP_DESCRIPTOR,
	GO_DESCRIPTOR,
	PYTHON_DESCRIPTOR,
	RUST_DESCRIPTOR,
	TYPESCRIPT_DESCRIPTOR,
} from "../../src/code-intelligence/language-server-descriptor.ts";
import type { LspPlatform } from "../../src/lsp-provisioning/lsp-platform.ts";

const platform = (os: LspPlatform["os"], arch: LspPlatform["arch"], libc?: LspPlatform["libc"]): LspPlatform => ({ os, arch, libc });

function requireGithubSource(descriptor: typeof RUST_DESCRIPTOR | typeof CPP_DESCRIPTOR) {
	const source = descriptor.provisioning;
	if (source?.kind !== "github-release") throw new Error(`${descriptor.backendId} must use a GitHub release source`);
	return source;
}

describe("managed language-server descriptors", () => {
	it("matches rust-analyzer's published archive names across supported targets", () => {
		const source = requireGithubSource(RUST_DESCRIPTOR);
		expect(source.assetName(platform("linux", "x64", "glibc"), "2026-08-03")).toBe("rust-analyzer-x86_64-unknown-linux-gnu.gz");
		expect(source.assetName(platform("linux", "x64", "musl"), "2026-08-03")).toBe("rust-analyzer-x86_64-unknown-linux-musl.gz");
		expect(source.assetName(platform("darwin", "arm64"), "2026-08-03")).toBe("rust-analyzer-aarch64-apple-darwin.gz");
		expect(source.assetName(platform("win32", "x86"), "2026-08-03")).toBe("rust-analyzer-i686-pc-windows-msvc.zip");
		expect(source.assetName(platform("linux", "x86", "glibc"), "2026-08-03")).toBeUndefined();
	});

	it("matches clangd's version-bearing release names and archive paths", () => {
		const source = requireGithubSource(CPP_DESCRIPTOR);
		expect(source.assetName(platform("linux", "x64", "glibc"), "22.1.6")).toBe("clangd-linux-22.1.6.zip");
		expect(source.assetName(platform("darwin", "arm64"), "22.1.6")).toBe("clangd-mac-22.1.6.zip");
		expect(source.binPathInArchive(platform("win32", "x64"), "22.1.6")).toBe("clangd_22.1.6/bin/clangd.exe");
		expect(source.assetName(platform("linux", "arm64", "glibc"), "22.1.6")).toBeUndefined();
	});

	it("does not claim managed sources for unsupported distribution models", () => {
		expect(GO_DESCRIPTOR.provisioning).toBeUndefined();
		expect(BASH_DESCRIPTOR.provisioning).toBeUndefined();
	});

	it("gives pyright a longer workspace-ready budget than the generic default -- its own background stub indexing legitimately outlasts 30s on a cold workspace", () => {
		expect(PYTHON_DESCRIPTOR.workspaceReadyTimeoutMs).toBe(90_000);
		expect(TYPESCRIPT_DESCRIPTOR.workspaceReadyTimeoutMs).toBeUndefined(); // unset languages still fall back to LspSymbolIndex's own 30s default
	});

	it("gives clangd a longer post-open settle than the generic default, matching rust-analyzer's own precedent -- cross-header hover/definition resolution needs its background indexer to catch up, and the generic default was observed producing an intermittent wrong-answer flake under CI's own constrained CPU budget", () => {
		expect(CPP_DESCRIPTOR.settleMs).toBeGreaterThanOrEqual(3000);
	});
});
