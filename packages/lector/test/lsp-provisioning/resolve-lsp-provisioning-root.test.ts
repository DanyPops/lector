import { describe, expect, it } from "bun:test";
import { resolveLspProvisioningRoot } from "../../src/lsp-provisioning/resolve-lsp-provisioning-root.ts";

describe("resolveLspProvisioningRoot", () => {
	it("resolves to an 'lsp-servers' sibling of the daemon's own database file", () => {
		const paths = {
			database: "/home/user/.local/share/lector/lector.db",
			token: "/home/user/.local/state/lector/token",
			handle: "/run/user/1000/lector/handle.json",
			serviceDescriptor: "/home/user/.config/systemd/user/lector.service",
		};
		expect(resolveLspProvisioningRoot(paths)).toBe("/home/user/.local/share/lector/lsp-servers");
	});
});
