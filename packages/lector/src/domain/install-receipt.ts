import type { LanguageServerSource } from "./language-server-package-spec.ts";

/** What was actually installed and where -- not just "a binary exists at this path". Enables idempotent reinstall (skip when the requested version already matches) and precise uninstall (every path this receipt names is this package's own, safe to remove). */
export interface InstallReceipt {
	readonly packageId: string;
	readonly source: LanguageServerSource;
	readonly resolvedVersion: string;
	readonly binPath: string;
	readonly installedAt: string;
}

/** A stable, human-auditable identity string for one receipt's source+version, PURL-shaped (https://github.com/package-url/purl-spec) -- not a strict validator, just a consistent, greppable identity matching mason.nvim's own receipt convention. */
export function receiptPurl(receipt: Pick<InstallReceipt, "source" | "resolvedVersion">): string {
	if (receipt.source.kind === "npm") return `pkg:npm/${encodeURIComponent(receipt.source.packageName)}@${encodeURIComponent(receipt.resolvedVersion)}`;
	return `pkg:github/${receipt.source.repo}@${encodeURIComponent(receipt.resolvedVersion)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Parses a receipt previously written by serializeInstallReceipt; undefined for anything malformed rather than throwing -- a corrupted/foreign receipt file must be treated as "not installed yet", never crash provisioning. */
export function parseInstallReceipt(raw: unknown): InstallReceipt | undefined {
	if (!isRecord(raw)) return undefined;
	const { packageId, source, resolvedVersion, binPath, installedAt } = raw;
	if (typeof packageId !== "string" || typeof resolvedVersion !== "string" || typeof binPath !== "string" || typeof installedAt !== "string") {
		return undefined;
	}
	if (!isRecord(source) || typeof source.kind !== "string") return undefined;
	if (source.kind === "npm") {
		if (typeof source.packageName !== "string" || typeof source.binName !== "string") return undefined;
		return { packageId, resolvedVersion, binPath, installedAt, source: { kind: "npm", packageName: source.packageName, binName: source.binName } };
	}
	if (source.kind === "github-release") {
		if (typeof source.repo !== "string") return undefined;
		// assetName/binPathInArchive are functions on the live spec, never persisted -- a parsed receipt
		// carries only the resolved facts (repo, version) needed to prove "already installed", not the
		// original spec's own behavior.
		return {
			packageId,
			resolvedVersion,
			binPath,
			installedAt,
			source: { kind: "github-release", repo: source.repo, assetName: () => undefined, binPathInArchive: () => "" },
		};
	}
	return undefined;
}

export function serializeInstallReceipt(receipt: InstallReceipt): string {
	const persisted =
		receipt.source.kind === "npm"
			? { kind: "npm", packageName: receipt.source.packageName, binName: receipt.source.binName }
			: { kind: "github-release", repo: receipt.source.repo };
	return JSON.stringify(
		{ packageId: receipt.packageId, source: persisted, resolvedVersion: receipt.resolvedVersion, binPath: receipt.binPath, installedAt: receipt.installedAt },
		null,
		2,
	);
}
