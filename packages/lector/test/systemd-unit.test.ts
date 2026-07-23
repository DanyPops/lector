import { describe, expect, it } from "bun:test";
import { renderSystemdUnit } from "../src/cli.ts";

describe("Lector systemd service", () => {
	it("renders a restartable long-running user unit that runs in dynamic-workspaces mode", () => {
		const unit = renderSystemdUnit({
			bunBin: "/home/u/.bun/bin/bun",
			cliPath: "/home/u/Projects/lector/src/cli.ts",
		});
		// --dynamic-workspaces, not a bare `serve`: a persistent background daemon cannot know
		// upfront which project(s) will attach to it (see createLectorService's allowDynamicOnly).
		expect(unit).toContain("ExecStart=/home/u/.bun/bin/bun /home/u/Projects/lector/src/cli.ts serve --dynamic-workspaces");
		expect(unit).toContain("Restart=always");
		expect(unit).toContain("WantedBy=default.target");
	});
});
