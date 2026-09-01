/**
 * Exercises the shared Vehicle conformance fixture and the complete Lector-owned production
 * renderer matrix, including every multiplexer action and the read/write/edit overrides.
 */
import { describe, expect, it } from "bun:test";
import type { PackageSourceOperationResult, PackageSourceOutcome } from "@danypops/lector";
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { runToolShellDualChannelConformance, type ToolShellDualChannelFixture } from "@danypops/vehicle-conformance";
import { initTheme, Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import lectorExtension from "../extension/src/index.ts";
import { projectLectorPresentation } from "../extension/src/presentation/presentation-contract.ts";
import { LECTOR_TOOL_PRESENTATION_SPECS, presentationTitle } from "../extension/src/presentation/tool-presentation.ts";

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

function resultOf(outcome: PackageSourceOutcome): PackageSourceOperationResult {
	return { outcome, workspaceId: outcome.status === "verified" ? "ws-1" : null };
}

const fixture: ToolShellDualChannelFixture = {
	label: "pi-lector (package_source resolve)",
	async create() {
		const harness = createExtensionHarness(lectorExtension, { cwd: process.cwd() });
		await harness.boot();
		const tool = harness.tools.get("package_source")?.definition;
		const renderCall = tool?.renderCall;
		const renderResult = tool?.renderResult;
		if (!renderCall || !renderResult) throw new Error("package_source must register both production renderers");
		const render = (details: unknown, contentText: string, options: { width: 40 | 80 | 120; expanded: boolean; partial?: boolean }): string[] => {
			const component = renderResult(
				{ content: [{ type: "text", text: contentText }], details } as never,
				{ isPartial: options.partial === true, expanded: options.expanded },
				theme,
				{ cwd: process.cwd(), isError: false } as never,
			);
			return component.render(options.width);
		};
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
			) => render(snapshot.details, snapshot.content, options),
			replay: (details: unknown, fallbackContent: string, options: { width: 40 | 80 | 120 }) =>
				render(details, fallbackContent, { ...options, expanded: false }),
			renderCall: (args: unknown, width: 40 | 80 | 120) => renderCall(args as never, theme, { cwd: process.cwd() } as never).render(width),
			invalidProjection: async () => {
				const cyclic: { self?: unknown } = {};
				cyclic.self = cyclic;
				projectLectorPresentation("package_source", cyclic);
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
		return { subject, cleanup: () => harness.shutdown() };
	},
};

runToolShellDualChannelConformance(fixture);

describe("pi-lector production tool renderer wiring", () => {
	it("registers both channels for every Lector-owned tool", async () => {
		const harness = createExtensionHarness(lectorExtension, { cwd: process.cwd() });
		try {
			await harness.boot();
			const lectorTools = [...harness.tools.values()];
			expect(lectorTools).toHaveLength(34);
			const missingCallRenderers = lectorTools.filter(({ definition }) => !definition.renderCall).map(({ name }) => name);
			const missingResultRenderers = lectorTools.filter(({ definition }) => !definition.renderResult).map(({ name }) => name);
			expect(missingCallRenderers).toEqual([]);
			expect(missingResultRenderers).toEqual([]);
		} finally {
			await harness.shutdown();
		}
	});

	it("renders all 70 action paths through production definitions with human titles", async () => {
		const harness = createExtensionHarness(lectorExtension, { cwd: process.cwd() });
		try {
			await harness.boot();
			for (const [toolName, spec] of Object.entries(LECTOR_TOOL_PRESENTATION_SPECS)) {
				const definition = harness.tools.get(toolName)?.definition;
				if (!definition?.renderCall) throw new Error(`${toolName} is missing a call renderer`);
				const actions = spec.actions ? Object.keys(spec.actions) : [undefined];
				for (const action of actions) {
					const args = {
						action,
						direction: action,
						path: "src/index.ts",
						fromPath: "src/old.ts",
						toPath: "src/new.ts",
						directory: ".",
						directories: ["."],
						query: "widget",
						patterns: ["*.ts"],
						line: 1,
						character: 1,
					};
					const rendered = definition
						.renderCall(args as never, theme, { cwd: process.cwd(), state: {} } as never)
						.render(120)
						.join("\n");
					if (!["read", "write", "edit"].includes(toolName))
						expect(rendered, `${toolName}:${action ?? "default"}`).toContain(presentationTitle(toolName, action));
				}
			}
		} finally {
			await harness.shutdown();
		}
	});

	it("falls back to semantic model content for malformed replay across every custom tool", async () => {
		const harness = createExtensionHarness(lectorExtension, { cwd: process.cwd() });
		try {
			await harness.boot();
			for (const { name, definition } of harness.tools.values()) {
				if (["read", "write", "edit"].includes(name)) continue;
				if (!definition.renderResult) throw new Error(`${name} is missing a result renderer`);
				const rendered = definition
					.renderResult(
						{ content: [{ type: "text", text: "SEMANTIC_REPLAY_FALLBACK" }], details: { schema: "unknown/v9" } } as never,
						{ isPartial: false, expanded: false },
						theme,
						{ cwd: process.cwd(), isError: false, state: {} } as never,
					)
					.render(80)
					.join("\n");
				expect(rendered, name).toContain("SEMANTIC_REPLAY_FALLBACK");
			}
		} finally {
			await harness.shutdown();
		}
	});

	it("renders every Lector-owned tool safely at responsive widths", async () => {
		const harness = createExtensionHarness(lectorExtension, { cwd: process.cwd() });
		const secret = "SECRET_CALL_ARGUMENT";
		try {
			await harness.boot();
			const lectorTools = [...harness.tools.values()];
			for (const { name, definition } of lectorTools) {
				if (!definition.renderCall || !definition.renderResult) throw new Error(`${name} is missing a renderer`);
				for (const width of [40, 80, 120] as const) {
					const callLines = definition.renderCall({ apiKey: secret, token: secret } as never, theme, { cwd: process.cwd(), state: {} } as never).render(width);
					expect(callLines.join("\n"), `${name} call arguments`).not.toContain(secret);
					const partialLines = definition
						.renderResult({ content: [{ type: "text", text: "MODEL_PARTIAL" }], details: undefined } as never, { isPartial: true, expanded: false }, theme, {
							cwd: process.cwd(),
							isError: false,
							state: {},
						} as never)
						.render(width);
					const errorLines = definition
						.renderResult({ content: [{ type: "text", text: "MODEL_ERROR" }], details: undefined } as never, { isPartial: false, expanded: false }, theme, {
							cwd: process.cwd(),
							isError: true,
							state: {},
						} as never)
						.render(width);
					expect(errorLines.join("\n"), `${name} error channel`).toContain("MODEL_ERROR");
					for (const line of [...callLines, ...partialLines, ...errorLines])
						expect(visibleWidth(line), `${name} at ${width} columns`).toBeLessThanOrEqual(width);
				}
			}
		} finally {
			await harness.shutdown();
		}
	});
});
