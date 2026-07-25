/**
 * Narrows a fixture variable assigned in one test-lifecycle function (e.g. `it()`'s own body)
 * and read inside a different closure (e.g. an injected callback) -- TypeScript's control-flow
 * narrowing doesn't cross function boundaries, so the real alternative here is a bare `!`, not a
 * false positive to silence.
 */
export function requireDefined<T>(value: T | undefined, label: string): T {
	if (value === undefined) throw new Error(`${label} was not set -- fixture setup must run before this is read`);
	return value;
}
