/**
 * Runs @danypops/vehicle-conformance's dual-channel matrix against pi-lector's own real
 * production rendering path for package_source's "resolve" action: an explicit discriminated
 * PackageSourceOutcome.status union with a compile-time `const exhaustive: never` guard, matching
 * cross-workspace-search/rendering.ts's own pattern.
 *
 * Every JSON.stringify() call in this package's rendering modules sits inside an already-exhaustive
 * never-guard's own unreachable-error message, never a silent fallback render -- so this fixture
 * targets the one representative renderer with the strongest pattern rather than one per tool.
 */
import type { PackageSourceOperationResult, PackageSourceOutcome } from "@danypops/lector";
import { runToolShellDualChannelConformance, type ToolShellDualChannelFixture } from "@danypops/vehicle-conformance";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import {
	formatPackageSourceCall,
	formatPackageSourceCleanResult,
	formatPackageSourceListResult,
	formatPackageSourceRemoveResult,
	formatPackageSourceResult,
} from "../extension/src/package-source/rendering.ts";

// A real Theme emitting real ANSI SGR escapes -- required because the conformance suite's own
// physical-line-width assertion strips real ANSI via a CSI regex before counting visible width.
const REAL_FG_COLORS: Record<ThemeColor, string> = {
	accent: "#ee0000",
	border: "#4d4d4d",
	borderAccent: "#ee0000",
	borderMuted: "#383838",
	success: "#6c9b4b",
	error: "#bd6e51",
	warning: "#dca614",
	muted: "#8f8f8f",
	dim: "#757575",
	text: "#e0e0e0",
	thinkingText: "#8f8f8f",
	userMessageText: "#e0e0e0",
	customMessageText: "#e0e0e0",
	customMessageLabel: "#876fd4",
	toolTitle: "#d39292",
	toolOutput: "#e0e0e0",
	mdHeading: "#e0e0e0",
	mdLink: "#0066cc",
	mdLinkUrl: "#0066cc",
	mdCode: "#e0e0e0",
	mdCodeBlock: "#e0e0e0",
	mdCodeBlockBorder: "#383838",
	mdQuote: "#8f8f8f",
	mdQuoteBorder: "#383838",
	mdHr: "#383838",
	mdListBullet: "#e0e0e0",
	toolDiffAdded: "#6c9b4b",
	toolDiffRemoved: "#bd6e51",
	toolDiffContext: "#8f8f8f",
	syntaxComment: "#8f8f8f",
	syntaxKeyword: "#876fd4",
	syntaxFunction: "#63bdbd",
	syntaxVariable: "#e0e0e0",
	syntaxString: "#6c9b4b",
	syntaxNumber: "#dca614",
	syntaxType: "#63bdbd",
	syntaxOperator: "#e0e0e0",
	syntaxPunctuation: "#e0e0e0",
	thinkingOff: "#8f8f8f",
	thinkingMinimal: "#8f8f8f",
	thinkingLow: "#8f8f8f",
	thinkingMedium: "#8f8f8f",
	thinkingHigh: "#8f8f8f",
	thinkingXhigh: "#8f8f8f",
	thinkingMax: "#8f8f8f",
	bashMode: "#e0e0e0",
};

const REAL_BG_COLORS = {
	selectedBg: "#292929",
	userMessageBg: "#1f1f1f",
	customMessageBg: "#1b0d33",
	toolPendingBg: "#1f1f1f",
	toolSuccessBg: "#1d2b12",
	toolErrorBg: "#4c1405",
};

const theme = new Theme(REAL_FG_COLORS, REAL_BG_COLORS, "truecolor");
initTheme();

interface PackageSourceToolDetailsLike {
	readonly action?: unknown;
	readonly result?: unknown;
	readonly page?: unknown;
}

/**
 * Mirrors package_source's own real renderResult dispatch in index.ts, minus the non-empty-list
 * Table branch (not exercised by this fixture's declared values): a malformed/unknown-shaped
 * details blob falls back to the model-facing content channel before the generic
 * "No package-source result." message, rather than discarding content on every non-error render.
 */
function render(details: PackageSourceToolDetailsLike | undefined, contentText: string, options: { width: 40 | 80 | 120; expanded: boolean }): string[] {
	let text: string;
	if (details?.action === "list") text = formatPackageSourceListResult(details.page as never, theme);
	else if (details?.action === "remove") text = formatPackageSourceRemoveResult(details.result as never, theme);
	else if (details?.action === "clean") text = formatPackageSourceCleanResult(details.result as never, theme);
	else if (details?.action === "resolve") text = formatPackageSourceResult(details.result as PackageSourceOperationResult, options.expanded, theme);
	else text = contentText || formatPackageSourceResult(undefined, options.expanded, theme);
	return text.split("\n").map((line) => truncateToWidth(line, options.width));
}

function resultOf(outcome: PackageSourceOutcome): PackageSourceOperationResult {
	return { outcome, workspaceId: outcome.status === "verified" ? "ws-1" : null };
}

const fixture: ToolShellDualChannelFixture = {
	label: "pi-lector (package_source resolve)",
	async create() {
		const subject = {
			bounds: { modelContentBytes: 8_192, presentationDetailsBytes: 32_768 },
			execute: async () => {
				const result = resultOf({
					status: "verified",
					coordinate: { ecosystem: "npm", registry: null, name: "PRESENTATION_ONLY-pkg", requestedVersion: null, resolvedVersion: "1.0.0" },
					repository: { url: "https://example.com/repo.git", requestedRef: null, resolvedRef: "main", commit: "abc123" },
					workspace: { cachePath: "/tmp/cache/PRESENTATION_ONLY-pkg", origin: "fetched", readOnly: true },
					verification: { status: "verified", method: "lockfile-vcs-pin", integrity: "sha256-abc" },
				});
				return { content: "MODEL_ONLY: semantic result", details: { action: "resolve" as const, result } };
			},
			render: (
				snapshot: { content: string; details: { action: "resolve"; result: PackageSourceOperationResult } },
				options: { width: 40 | 80 | 120; expanded: boolean; partial?: boolean },
			) => (options.partial ? [theme.fg("warning", "Working on package source...")] : render(snapshot.details, snapshot.content, options)),
			replay: (details: unknown, fallbackContent: string, options: { width: 40 | 80 | 120 }) =>
				render(details as PackageSourceToolDetailsLike | undefined, fallbackContent, { ...options, expanded: false }),
			renderCall: (args: unknown, width: 40 | 80 | 120) => [truncateToWidth(formatPackageSourceCall(args as Record<string, unknown>, theme), width)],
			invalidProjection: async () => {
				// formatPackageSourceResult's own never-guard genuinely throws at runtime for an
				// outcome whose status isn't one of the 6 declared PackageSourceOutcome members --
				// the literal "documented projector exception policy" in action, not a stand-in.
				const bogus = { status: "not-a-real-status" } as unknown as PackageSourceOutcome;
				formatPackageSourceResult(resultOf(bogus), false, theme);
			},
			// One representative real payload per PackageSourceOutcome.status -- proves the real
			// exhaustive-switch renderer differentiates all 6 declared statuses instead of collapsing
			// into an undifferentiated raw-JSON dump of the payload.
			declaredValueCases: [
				{
					value: "verified",
					rawPayload: resultOf({
						status: "verified",
						coordinate: { ecosystem: "npm", registry: null, name: "example", requestedVersion: null, resolvedVersion: "1.0.0" },
						repository: { url: "https://example.com/repo.git", requestedRef: null, resolvedRef: "main", commit: "abc123" },
						workspace: { cachePath: "/tmp/cache/example", origin: "fetched", readOnly: true },
						verification: { status: "verified", method: "lockfile-vcs-pin", integrity: "sha256-abc" },
					}),
				},
				{
					value: "ambiguous",
					rawPayload: resultOf({
						status: "ambiguous",
						code: "multiple-source-candidates",
						candidates: [{ version: "1.0.0", source: "https://a.example.com" }],
						truncated: false,
					}),
				},
				{
					value: "unauthenticated",
					rawPayload: resultOf({ status: "unauthenticated", code: "registry-authentication-required", requiredCredentialNames: ["NPM_TOKEN"] }),
				},
				{
					value: "oversized",
					rawPayload: resultOf({ status: "oversized", code: "manifest-limit-exceeded", resource: "manifest-bytes", limit: 100, observed: 500 }),
				},
				{
					value: "mismatched",
					rawPayload: resultOf({ status: "mismatched", code: "integrity-mismatch", expected: "sha256-a", actual: "sha256-b" }),
				},
				{ value: "unavailable", rawPayload: resultOf({ status: "unavailable", code: "package-not-found" }) },
			],
			renderDeclaredValue: (_value: string, rawPayload: unknown, options: { width: 40 | 80 | 120; expanded: boolean }) =>
				render({ action: "resolve", result: rawPayload as PackageSourceOperationResult }, "MODEL_ONLY", options),
		};
		return { subject, cleanup: () => Promise.resolve() };
	},
};

runToolShellDualChannelConformance(fixture);
