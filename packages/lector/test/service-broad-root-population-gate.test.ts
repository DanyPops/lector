/**
 * Live stress-test evidence: a stale ~/.config registration produced a 500-file population over
 * unrelated application caches (177 failed files, 958 failure records); ~/.pi/agent queued
 * behind real projects and then failed UnsupportedLanguage. Neither directory is a real
 * project -- workspace.populateSymbolGraph must refuse both outright unless explicitly allowed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BroadNonProjectRoot, createLectorService, type LectorService } from "../src/service.ts";

let fakeHome: string | undefined;
let service: LectorService | undefined;

afterEach(async () => {
	await service?.close();
	service = undefined;
	if (fakeHome) rmSync(fakeHome, { recursive: true, force: true });
	fakeHome = undefined;
});

async function registerAndBuild(rootPath: string): Promise<{ service: LectorService; workspaceId: string }> {
	const svc = createLectorService(new Map(), { allowDynamicOnly: true, homeDir: fakeHome as string });
	const { workspaceId } = await svc.dispatch("workspace.registerPath", { path: rootPath });
	return { service: svc, workspaceId };
}

describe("createLectorService's broad-non-project-root population gate", () => {
	it("refuses to populate a bare $HOME/.config-shaped directory, matching the live evidence exactly", async () => {
		fakeHome = mkdtempSync(join(tmpdir(), "lector-broad-root-home-"));
		const configDir = join(fakeHome, ".config", "Cursor");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "settings.json"), "{}");
		const built = await registerAndBuild(configDir);
		service = built.service;

		await expect(
			service.dispatch("workspace.populateSymbolGraph", { workspaceId: built.workspaceId, maxFiles: 500, maxSymbolsPerFile: 100 }),
		).rejects.toBeInstanceOf(BroadNonProjectRoot);
	});

	it("refuses ~/.pi/agent the same way -- a dotfile-prefixed ancestor two levels up", async () => {
		fakeHome = mkdtempSync(join(tmpdir(), "lector-broad-root-home-"));
		const piAgentDir = join(fakeHome, ".pi", "agent");
		mkdirSync(piAgentDir, { recursive: true });
		const built = await registerAndBuild(piAgentDir);
		service = built.service;

		await expect(
			service.dispatch("workspace.populateSymbolGraph", { workspaceId: built.workspaceId, maxFiles: 500, maxSymbolsPerFile: 100 }),
		).rejects.toBeInstanceOf(BroadNonProjectRoot);
	});

	it("still allows ordinary read/write against a rejected root -- this gates auto-population only, not raw file access", async () => {
		fakeHome = mkdtempSync(join(tmpdir(), "lector-broad-root-home-"));
		const configDir = join(fakeHome, ".config");
		mkdirSync(configDir, { recursive: true });
		const built = await registerAndBuild(configDir);
		service = built.service;

		const written = await service.dispatch("workspace.exactEdit", { workspaceId: built.workspaceId, path: "note.txt", expectedHash: null, content: "hi" });
		expect(written.newHash).toBeTruthy();
		await expect(service.dispatch("workspace.rawRead", { workspaceId: built.workspaceId, path: "note.txt" })).resolves.toMatchObject({ content: "hi" });
	});

	it("proceeds normally when allowBroadRoot: true is passed -- an explicit, auditable opt-in", async () => {
		fakeHome = mkdtempSync(join(tmpdir(), "lector-broad-root-home-"));
		const configDir = join(fakeHome, ".config", "empty");
		mkdirSync(configDir, { recursive: true });
		writeFileSync(join(configDir, "whatever.ts"), "export const x = 1;\n");
		const built = await registerAndBuild(configDir);
		service = built.service;

		const result = await service.dispatch("workspace.populateSymbolGraph", {
			workspaceId: built.workspaceId,
			maxFiles: 500,
			maxSymbolsPerFile: 100,
			allowBroadRoot: true,
		});
		expect(result.filesAttempted).toEqual(1);
	});

	it("never refuses a real project even when it happens to live under a dotfile directory", async () => {
		fakeHome = mkdtempSync(join(tmpdir(), "lector-broad-root-home-"));
		const projectDir = join(fakeHome, ".dotfiles-project");
		mkdirSync(join(projectDir, ".git"), { recursive: true });
		writeFileSync(join(projectDir, "whatever.ts"), "export const x = 1;\n");
		const built = await registerAndBuild(projectDir);
		service = built.service;

		const result = await service.dispatch("workspace.populateSymbolGraph", { workspaceId: built.workspaceId, maxFiles: 500, maxSymbolsPerFile: 100 });
		expect(result.filesAttempted).toEqual(1);
	});

	it("refuses via job.submit too, not just the direct dispatch path", async () => {
		fakeHome = mkdtempSync(join(tmpdir(), "lector-broad-root-home-"));
		const configDir = join(fakeHome, ".config");
		mkdirSync(configDir, { recursive: true });
		const built = await registerAndBuild(configDir);
		service = built.service;

		const { job } = await service.dispatch("job.submit", {
			operation: "workspace.populateSymbolGraph",
			input: { workspaceId: built.workspaceId, maxFiles: 500, maxSymbolsPerFile: 100 },
			waitMs: 5_000,
		});
		expect(job.status).toBe("failed");
		expect(job.status === "failed" ? job.error.message : undefined).toContain("broad host directory");
	});
});
