import { describe, expect, it } from "bun:test";
import { shouldRefetchFromRemote } from "../../src/domain/remote-cache-freshness.ts";

describe("shouldRefetchFromRemote", () => {
	it("refetches when the remote's current commit genuinely differs from what was recorded", () => {
		expect(shouldRefetchFromRemote({ recordedCommit: "abc123", currentRemoteCommit: "def456" })).toBe(true);
	});

	it("does not refetch when the remote's current commit matches what was recorded", () => {
		expect(shouldRefetchFromRemote({ recordedCommit: "abc123", currentRemoteCommit: "abc123" })).toBe(false);
	});

	it("does not refetch when nothing was ever recorded -- not this check's job", () => {
		expect(shouldRefetchFromRemote({ recordedCommit: undefined, currentRemoteCommit: "def456" })).toBe(false);
	});

	it("does not refetch when the remote couldn't be reached -- inconclusive must never force a failing refetch", () => {
		expect(shouldRefetchFromRemote({ recordedCommit: "abc123", currentRemoteCommit: undefined })).toBe(false);
	});

	it("does not refetch when neither side is known", () => {
		expect(shouldRefetchFromRemote({ recordedCommit: undefined, currentRemoteCommit: undefined })).toBe(false);
	});
});
