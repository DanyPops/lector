import { describe, expect, it } from "bun:test";
import { classifyAutoPopulationRoot } from "../../src/workspace/classify-auto-population-root.ts";

const HOME = "/home/dpopsuev";

describe("classifyAutoPopulationRoot", () => {
	it("classifies the home directory itself as broad-non-project, even with no markers", () => {
		expect(classifyAutoPopulationRoot({ rootPath: HOME, homeDir: HOME, topLevelEntries: [".bashrc", "Projects", "Downloads"] })).toBe("broad-non-project");
	});

	it("classifies the live stress-test evidence: ~/.config with real-looking cache subfolders", () => {
		expect(classifyAutoPopulationRoot({ rootPath: `${HOME}/.config`, homeDir: HOME, topLevelEntries: ["Cursor", "systemd", "armada"] })).toBe(
			"broad-non-project",
		);
	});

	it("classifies the live stress-test evidence: ~/.pi/agent, a dotfile-prefixed ancestor two levels up", () => {
		expect(classifyAutoPopulationRoot({ rootPath: `${HOME}/.pi/agent`, homeDir: HOME, topLevelEntries: ["sessions", "npm"] })).toBe("broad-non-project");
	});

	it("classifies a real git repository under Projects as real-project", () => {
		expect(classifyAutoPopulationRoot({ rootPath: `${HOME}/Projects/lector`, homeDir: HOME, topLevelEntries: [".git", "packages", "package.json"] })).toBe(
			"real-project",
		);
	});

	it("classifies a real project even when it happens to live under a dotfile directory -- a marker always wins", () => {
		expect(classifyAutoPopulationRoot({ rootPath: `${HOME}/.dotfiles`, homeDir: HOME, topLevelEntries: [".git", "bashrc", "vimrc"] })).toBe("real-project");
	});

	it("classifies a brand-new, markerless project directory outside home's dotfile segments as real-project -- not everything markerless is rejected", () => {
		expect(classifyAutoPopulationRoot({ rootPath: "/tmp/scratch-project", homeDir: HOME, topLevelEntries: ["index.ts"] })).toBe("real-project");
	});

	it("classifies a Go project by go.mod alone", () => {
		expect(classifyAutoPopulationRoot({ rootPath: `${HOME}/Projects/service`, homeDir: HOME, topLevelEntries: ["go.mod", "main.go"] })).toBe("real-project");
	});

	it("classifies a Rust project by Cargo.toml alone", () => {
		expect(classifyAutoPopulationRoot({ rootPath: `${HOME}/Projects/crate`, homeDir: HOME, topLevelEntries: ["Cargo.toml", "src"] })).toBe("real-project");
	});
});
