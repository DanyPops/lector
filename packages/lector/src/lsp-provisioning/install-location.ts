import { join } from "node:path";

/**
 * Mason.nvim-shaped install-root layout (`bin/`, `packages/`, `staging/`) under one directory --
 * see resolve-lsp-provisioning-root.ts for where that directory itself lives relative to
 * Lector's own XDG state paths. `bin/` holds only symlinks into `packages/<id>/`, matching
 * mason's own linker.lua: multiple package versions can coexist on disk, and PATH never needs
 * to know about any of them directly.
 */
export class InstallLocation {
	constructor(private readonly root: string) {}

	get bin(): string {
		return join(this.root, "bin");
	}

	get staging(): string {
		return join(this.root, "staging");
	}

	packageDir(packageId: string): string {
		return join(this.root, "packages", packageId);
	}

	receiptPath(packageId: string): string {
		return join(this.root, "packages", packageId, ".receipt.json");
	}

	binLink(binName: string): string {
		return join(this.bin, binName);
	}

	lockPath(packageId: string): string {
		return join(this.staging, `${packageId}.lock`);
	}
}
