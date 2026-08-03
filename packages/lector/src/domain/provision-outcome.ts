import type { InstallReceipt } from "./install-receipt.ts";

/**
 * "already-installed" -- a receipt already matches the requested version; no install ran.
 * "installed" -- a real install ran and succeeded.
 * "unavailable" -- expected failure a caller can reasonably branch on: no network, the version
 * doesn't exist, no release asset matches this platform. Never thrown -- provisioning is
 * best-effort from a code-intelligence caller's point of view (see ensureInstalled's own
 * doc comment): the caller falls back to "server not found" exactly as it did before this
 * feature existed, not a crash.
 * "timed-out" -- the bounded install budget elapsed before the install (resolve+download+
 * extract, whichever stage was in flight) finished. Distinguished from "unavailable" because a
 * caller may reasonably want to log/report this differently (a stalled network vs a genuinely
 * missing package).
 *
 * A real discriminated union, not one interface with optional fields, so `outcome.kind ===
 * "installed"` narrows `binPath`/`receipt` without a caller needing its own assertion.
 */
export type ProvisionOutcome =
	| { readonly kind: "already-installed"; readonly binPath: string; readonly receipt: InstallReceipt }
	| { readonly kind: "installed"; readonly binPath: string; readonly receipt: InstallReceipt }
	| { readonly kind: "unavailable"; readonly reason: string }
	| { readonly kind: "timed-out" };
