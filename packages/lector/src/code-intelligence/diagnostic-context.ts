import { EventEmitter, once } from "node:events";
import type { ContentHash } from "../content-identity/content-hash.ts";

type SetupKind = "standard-library" | "build-script" | "proc-macro" | "project-metadata" | "interpreter" | "server-health" | "stale-diagnostics";

/** Describes a server-reported setup concern independently of native source diagnostics. */
export interface DiagnosticSetupFinding {
	readonly kind: SetupKind;
	readonly evidence: "server-status" | "server-message" | "document-version";
	readonly action: string;
}

/** Identifies synchronized source separately from the version attached to a diagnostic publication. */
export interface DiagnosticDocumentContext {
	readonly synchronizedVersion?: number;
	readonly publishedVersion?: number;
	readonly synchronizedContentHash?: ContentHash;
}

/** Reports bounded project evidence; reported readiness is a server claim, not compiler verification. */
export interface DiagnosticContext {
	readonly confidence: "reported-ready" | "degraded" | "unknown";
	readonly server: { readonly health?: "ok" | "warning" | "error"; readonly quiescent?: boolean; readonly version?: string };
	readonly document: DiagnosticDocumentContext;
	readonly setupFindings: readonly DiagnosticSetupFinding[];
	readonly configuration: "server-managed-unverified";
	readonly truncated: boolean;
}

const MAX_MESSAGE_CHARACTERS = 8192;
const SETUP_PATTERNS: readonly { kind: SetupKind; pattern: RegExp; action: string }[] = [
	{
		kind: "standard-library",
		pattern: /sysroot|rust-src|standard library.*(?:missing|failed|unavailable)/i,
		action: "Verify standard-library sources and the analyzer's selected toolchain, then reload the project.",
	},
	{
		kind: "build-script",
		pattern: /build[- ]script.*(?:fail|error|unavailable)/i,
		action: "Run the project's build scripts with the same features and environment, then reload the project.",
	},
	{
		kind: "proc-macro",
		pattern: /proc[- ]macro.*(?:fail|error|unavailable)/i,
		action: "Verify procedural macro builds and toolchain compatibility, then reload the project.",
	},
	{
		kind: "project-metadata",
		pattern: /(?:failed|unable|could not) to (?:load|discover).*(?:workspace|project)|cargo metadata.*(?:fail|error)/i,
		action: "Verify the registered project root and project metadata, then reload the project.",
	},
	{
		kind: "interpreter",
		pattern: /(?:python|interpreter).*(?:not found|could not be found|invalid|does not exist)|no python interpreter|venvPath.*not a valid directory/i,
		action: "Verify the configured Python interpreter and environment, then reload the project.",
	},
];

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Retains one finding per setup category for a server session, with fixed-size message inspection. */
export class DiagnosticContextTracker {
	private status: DiagnosticContext["server"] = {};
	private readonly messageFindings = new Map<SetupKind, DiagnosticSetupFinding>();
	private statusFindings: DiagnosticSetupFinding[] = [];
	private truncated = false;
	private readonly events = new EventEmitter().setMaxListeners(32);

	/** Records a bounded standard version string supplied by the server's initialize response. */
	recordServerInfo(value: unknown): void {
		if (!record(value) || typeof value.version !== "string") return;
		const version = value.version;
		if (version.length <= 128 && /^\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?(?: \([a-f0-9]{7,40}(?: \d{4}-\d{2}-\d{2})?\))?$/.test(version))
			this.status = { ...this.status, version };
	}

	/** Replaces project-health evidence using the server-status extension's validated notification. */
	recordStatus(value: unknown): void {
		if (!record(value) || typeof value.quiescent !== "boolean") return;
		const health = value.health;
		if (health !== "ok" && health !== "warning" && health !== "error") return;
		this.status = { ...this.status, health, quiescent: value.quiescent };
		this.statusFindings = health === "ok" ? [] : this.classify(value.message, "server-status");
		if (health === "ok" && value.quiescent) this.messageFindings.clear();
		if (health !== "ok" && this.statusFindings.length === 0)
			this.statusFindings.push({
				kind: "server-health",
				evidence: "server-status",
				action: "Inspect the language server's project setup before relying on semantic results.",
			});
		if (value.quiescent) this.events.emit("quiescent");
	}

	/** Subscribes to reported quiescence; unsupported status, saturation and deadline expiry return false. */
	async waitForQuiescence(timeoutMs: number): Promise<boolean> {
		if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new TypeError("timeoutMs must be an integer from 1 through 300000");
		if (this.status.quiescent !== false) return this.status.quiescent === true;
		if (this.events.listenerCount("quiescent") >= 32) return false;
		try {
			await once(this.events, "quiescent", { signal: AbortSignal.timeout(timeoutMs) });
			return true;
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") return false;
			throw error;
		}
	}

	/** Classifies bounded warning/error messages, retaining actions rather than raw server text. */
	recordMessage(value: unknown): void {
		if (!record(value) || (value.type !== 1 && value.type !== 2)) return;
		for (const finding of this.classify(value.message, "server-message")) this.messageFindings.set(finding.kind, finding);
	}

	/** Combines server evidence with synchronized and published document identities. */
	snapshot(document: DiagnosticDocumentContext): DiagnosticContext {
		const findings = new Map(this.messageFindings);
		for (const finding of this.statusFindings) findings.set(finding.kind, finding);
		if (document.synchronizedVersion !== undefined && document.publishedVersion !== undefined && document.synchronizedVersion !== document.publishedVersion)
			findings.set("stale-diagnostics", {
				kind: "stale-diagnostics",
				evidence: "document-version",
				action: "Wait for analysis of the synchronized document version before attributing published errors to current source.",
			});
		return {
			confidence: findings.size > 0 ? "degraded" : this.status.health === "ok" && this.status.quiescent && !this.truncated ? "reported-ready" : "unknown",
			server: { ...this.status },
			document: { ...document },
			setupFindings: [...findings.values()],
			configuration: "server-managed-unverified",
			truncated: this.truncated,
		};
	}

	private classify(message: unknown, evidence: DiagnosticSetupFinding["evidence"]): DiagnosticSetupFinding[] {
		if (typeof message !== "string") return [];
		if (message.length > MAX_MESSAGE_CHARACTERS) this.truncated = true;
		const bounded = message.slice(0, MAX_MESSAGE_CHARACTERS);
		return SETUP_PATTERNS.filter(({ pattern }) => pattern.test(bounded)).map(({ kind, action }) => ({ kind, evidence, action }));
	}
}
