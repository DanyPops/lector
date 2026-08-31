#!/usr/bin/env bun
import { fileURLToPath } from "node:url";

const MISSING_EXPORT_PATTERNS = [/Export named .+ not found/i, /does not provide an export named/i];

export function formatCliBootstrapError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (MISSING_EXPORT_PATTERNS.some((pattern) => pattern.test(message))) {
		return [
			"Lector CLI has an incompatible dependency closure (typically a stale hoisted Vehicle package).",
			"Reinstall the CLI and its managed service from one source:",
			"  bun remove --global @danypops/lector",
			"  bun add --global @danypops/lector@latest",
			"  lector service install",
			"For a Pi/Armada-managed installation, update @danypops/lector in ~/.pi/agent/npm and restart armada-lector.service instead of mixing it with the global CLI.",
		].join("\n");
	}
	return `Lector CLI failed to start: ${message}`;
}

export async function runCliBootstrap(): Promise<void> {
	try {
		const { main } = await import("./cli.ts");
		await main(process.argv.slice(2), fileURLToPath(import.meta.url));
	} catch (error) {
		console.error(formatCliBootstrapError(error));
		process.exitCode = 1;
	}
}

if (import.meta.main) await runCliBootstrap();
