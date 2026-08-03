import { describe, expect, it } from "bun:test";
import type { InstallReceipt } from "../../src/domain/install-receipt.ts";
import { parseInstallReceipt, receiptPurl, serializeInstallReceipt } from "../../src/domain/install-receipt.ts";

const NPM_RECEIPT: InstallReceipt = {
	packageId: "typescript-language-server",
	source: { kind: "npm", packageName: "typescript-language-server", binName: "typescript-language-server" },
	resolvedVersion: "4.3.3",
	binPath: "/root/bin/typescript-language-server",
	installedAt: "2024-01-01T00:00:00.000Z",
};

const GITHUB_RECEIPT: InstallReceipt = {
	packageId: "gopls",
	source: { kind: "github-release", repo: "golang/tools", assetName: () => "gopls_linux_x64", binPathInArchive: () => "gopls" },
	resolvedVersion: "v0.16.0",
	binPath: "/root/bin/gopls",
	installedAt: "2024-01-01T00:00:00.000Z",
};

describe("receiptPurl", () => {
	it("formats an npm source as a pkg:npm purl", () => {
		expect(receiptPurl(NPM_RECEIPT)).toBe("pkg:npm/typescript-language-server@4.3.3");
	});

	it("formats a github-release source as a pkg:github purl", () => {
		expect(receiptPurl(GITHUB_RECEIPT)).toBe("pkg:github/golang/tools@v0.16.0");
	});
});

describe("serializeInstallReceipt / parseInstallReceipt", () => {
	it("round-trips an npm receipt", () => {
		const parsed = parseInstallReceipt(JSON.parse(serializeInstallReceipt(NPM_RECEIPT)));
		expect(parsed).toEqual(NPM_RECEIPT);
	});

	it("round-trips a github-release receipt's own facts, not its behavior", () => {
		const parsed = parseInstallReceipt(JSON.parse(serializeInstallReceipt(GITHUB_RECEIPT)));
		expect(parsed?.packageId).toBe("gopls");
		expect(parsed?.resolvedVersion).toBe("v0.16.0");
		expect(parsed?.source).toEqual({ kind: "github-release", repo: "golang/tools", assetName: expect.any(Function), binPathInArchive: expect.any(Function) });
	});

	it("returns undefined for malformed or foreign JSON rather than throwing", () => {
		expect(parseInstallReceipt(null)).toBeUndefined();
		expect(parseInstallReceipt({})).toBeUndefined();
		expect(parseInstallReceipt({ packageId: "x" })).toBeUndefined();
		expect(parseInstallReceipt({ packageId: "x", source: { kind: "unknown" }, resolvedVersion: "1", binPath: "/x", installedAt: "now" })).toBeUndefined();
	});
});
