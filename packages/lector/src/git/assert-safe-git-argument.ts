import { assertNoLeadingFlagChar } from "@danypops/vehicle-core";

/** Raised when a caller-influenced string cannot safely reach git's argv. */
export class UnsafeGitArgument extends Error {
	constructor(readonly value: string) {
		super(`"${value}" cannot be used as a git argument -- it would be interpreted as a flag, not a literal value`);
		this.name = "UnsafeGitArgument";
	}
}

/**
 * Rejects any value git's own argv parser could interpret as a flag rather than a literal
 * ref/path -- the root cause of most git CLI injection CVEs (simple-git's own history:
 * `--upload-pack`, `--exec`, `--template`, `-c` config overrides all require the argument
 * to start with `-` to be parsed as a flag at all). Lector's git layer is read-only and never
 * needs to pass a caller-influenced flag, so this is a hard rejection, not a configurable
 * allow-list the way simple-git's own deny-by-category defense is for a general-purpose wrapper.
 * Delegates the actual check to vehicle-core's own assertNoLeadingFlagChar -- kept as a distinct
 * named error here since Lector's own error-catalog tests key off UnsafeGitArgument by name.
 */
export function assertSafeGitArgument(value: string): void {
	try {
		assertNoLeadingFlagChar(value);
	} catch {
		throw new UnsafeGitArgument(value);
	}
}
