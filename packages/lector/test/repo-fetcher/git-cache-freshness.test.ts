import { describe, expect, it } from "bun:test";
import { isCacheFreshByGit } from "../../src/repo-fetcher/git-cache-freshness.ts";

const BASE = { recordedHeadSha: "abc123", isGitRepository: true, workingTreeClean: true, currentHeadSha: "abc123" };

describe("isCacheFreshByGit", () => {
	it("is fresh when HEAD is unchanged and the tree is clean", () => {
		expect(isCacheFreshByGit(BASE)).toBe(true);
	});

	it("is not fresh when no sha was ever recorded (never a git repo, or was dirty at population time)", () => {
		expect(isCacheFreshByGit({ ...BASE, recordedHeadSha: undefined })).toBe(false);
	});

	it("is not fresh when the workspace is no longer (or never was) a git repository", () => {
		expect(isCacheFreshByGit({ ...BASE, isGitRepository: false })).toBe(false);
	});

	it("is not fresh when the working tree is currently dirty", () => {
		expect(isCacheFreshByGit({ ...BASE, workingTreeClean: false })).toBe(false);
	});

	it("is not fresh when HEAD has moved since population", () => {
		expect(isCacheFreshByGit({ ...BASE, currentHeadSha: "def456" })).toBe(false);
	});

	it("is not fresh when the current HEAD sha could not be determined at all", () => {
		expect(isCacheFreshByGit({ ...BASE, currentHeadSha: undefined })).toBe(false);
	});
});
