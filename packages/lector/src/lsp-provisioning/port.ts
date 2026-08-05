import type { LanguageServerPackageSpec } from "./language-server-package-spec.ts";
import type { ProvisionOutcome } from "./provision-outcome.ts";

/**
 * Resolves a missing language server binary on demand -- mason.nvim-shaped (pluggable version
 * providers, a staged install committed only on full success, a persisted receipt for
 * idempotent reinstall), not OpenCode's hardcoded per-language install functions. `ensureInstalled`
 * is the one entry point: idempotent (a matching receipt short-circuits to "already-installed"
 * without touching the network), race-safe under concurrent calls for the same spec, and always
 * resolves -- never throws -- because provisioning is a best-effort enhancement a code-intelligence
 * caller degrades gracefully without, exactly as it did before this port existed.
 */
export interface LanguageServerProvisionerPort {
	ensureInstalled(spec: LanguageServerPackageSpec): Promise<ProvisionOutcome>;
}
