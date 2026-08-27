/**
 * Behavioral tests for ExplorerComponent: assert on its own render() output and done() callback,
 * never on raw ANSI byte sequences or a real terminal, per this environment's "test behavior, not
 * pixels" TUI-testing standard. A minimal fake session models a real directory tree in memory so
 * navigation and mutation are exercised end to end without a real daemon.
 */

import { describe, expect, it } from "bun:test";
import type { DirectoryListing, FileTreeEntryKind } from "@danypops/lector";
import { renderToTerminal } from "@danypops/pi-tui-harness";
import type { TUI } from "@earendil-works/pi-tui";
import type { DirectoryExplorerSession } from "../../extension/src/editor/directory-explorer-operations.ts";
import type { EditorTheme } from "../../extension/src/editor/editor-theme.ts";
import type { ExplorerResult } from "../../extension/src/editor/explorer-component.ts";
import { ExplorerComponent } from "../../extension/src/editor/explorer-component.ts";

interface FakeNode {
	kind: FileTreeEntryKind;
	children?: Map<string, FakeNode>;
	content?: string;
}

function fakeTree(): Map<string, FakeNode> {
	const src = new Map<string, FakeNode>([["index.ts", { kind: "file", content: "export {};\n" }]]);
	return new Map<string, FakeNode>([
		["src", { kind: "directory", children: src }],
		["readme.md", { kind: "file", content: "hello\n" }],
	]);
}

function fakeSession(root: Map<string, FakeNode>): DirectoryExplorerSession {
	function resolve(path: string): Map<string, FakeNode> {
		if (path === "") return root;
		let current = root;
		for (const segment of path.split("/")) {
			const node = current.get(segment);
			if (!node?.children) throw new Error(`not a directory: ${path}`);
			current = node.children;
		}
		return current;
	}
	function splitParent(path: string): { parent: Map<string, FakeNode>; name: string } {
		const lastSlash = path.lastIndexOf("/");
		return lastSlash === -1 ? { parent: root, name: path } : { parent: resolve(path.slice(0, lastSlash)), name: path.slice(lastSlash + 1) };
	}
	return {
		root: "/repo",
		workspaceId: "ws" as never,
		listDirectory: async (path: string): Promise<DirectoryListing> => {
			const dir = resolve(path);
			return { path, entries: [...dir.entries()].map(([name, node]) => ({ name, kind: node.kind })) };
		},
		createFile: async (path: string) => {
			const { parent, name } = splitParent(path);
			parent.set(name, { kind: "file", content: "" });
		},
		createDirectory: async (path: string) => {
			const { parent, name } = splitParent(path);
			parent.set(name, { kind: "directory", children: new Map() });
		},
		renamePath: async (oldPath: string, newPath: string) => {
			const { parent: oldParent, name: oldName } = splitParent(oldPath);
			const node = oldParent.get(oldName);
			if (!node) throw new Error(`no entry at ${oldPath}`);
			oldParent.delete(oldName);
			const { parent: newParent, name: newName } = splitParent(newPath);
			newParent.set(newName, node);
		},
		deleteFile: async (path: string) => {
			const { parent, name } = splitParent(path);
			parent.delete(name);
		},
		deleteDirectory: async (path: string) => {
			const { parent, name } = splitParent(path);
			parent.delete(name);
		},
	};
}

const fakeTheme: EditorTheme = {
	fg: (_color, text) => text,
	bg: (_color, text) => text,
};

function fakeTui(): TUI {
	return { terminal: { rows: 24 }, requestRender: () => undefined } as unknown as TUI;
}

/** Waits one microtask turn -- ExplorerComponent's constructor kicks off loadDirectory() without the test being able to await it directly. */
function tick(): Promise<void> {
	return new Promise((resolvePromise) => setTimeout(resolvePromise, 0));
}

/** Feeds render() output through a real VT parser (@xterm/headless) instead of a hand-rolled ANSI-stripping regex -- asserts on displayed text content, not literal styling bytes, per this environment's "test behavior, not pixels" standard. */
async function renderPlain(component: ExplorerComponent, width: number): Promise<string[]> {
	const terminal = await renderToTerminal(component.render(width));
	const lines = terminal.plainLines();
	terminal.dispose();
	return lines;
}

describe("ExplorerComponent", () => {
	it("lists the initial directory's own entries, id-prefixed, on construction", async () => {
		const tui = fakeTui();
		let result: ExplorerResult | undefined;
		const component = new ExplorerComponent(tui, fakeTheme, fakeSession(fakeTree()), "", (r) => {
			result = r;
		});
		await tick();
		expect((await renderPlain(component, 80)).slice(0, 2)).toEqual(["1 src/", "2 readme.md"]);
		expect(result).toBeUndefined();
	});

	it("reveals an initial active entry so Enter reopens that file", async () => {
		const tui = fakeTui();
		let result: ExplorerResult | undefined;
		const component = new ExplorerComponent(tui, fakeTheme, fakeSession(fakeTree()), "", (next) => {
			result = next;
		}, "readme.md");
		await tick();
		await component.handleInput("\r");
		expect(result).toMatchObject({ kind: "open-file", absolutePath: "/repo/readme.md", viewState: { relativePath: "", selectedEntryName: "readme.md" } });
	});

	it("Enter on a directory line navigates into it", async () => {
		const tui = fakeTui();
		const component = new ExplorerComponent(tui, fakeTheme, fakeSession(fakeTree()), "", () => undefined);
		await tick();
		await component.handleInput("\r");
		expect((await renderPlain(component, 80)).slice(0, 1)).toEqual(["1 index.ts"]);
	});

	it("Enter on a file line calls done() with an open-file result at the real absolute path", async () => {
		const tui = fakeTui();
		let result: ExplorerResult | undefined;
		const component = new ExplorerComponent(tui, fakeTheme, fakeSession(fakeTree()), "", (r) => {
			result = r;
		});
		await tick();
		await component.handleInput("j"); // move to readme.md
		await component.handleInput("\r");
		expect(result).toEqual({ kind: "open-file", absolutePath: "/repo/readme.md", viewState: { relativePath: "", selectedEntryName: "readme.md" } });
	});

	it("'-' navigates back to the parent directory", async () => {
		const tui = fakeTui();
		const component = new ExplorerComponent(tui, fakeTheme, fakeSession(fakeTree()), "", () => undefined);
		await tick();
		await component.handleInput("\r"); // into src/
		expect((await renderPlain(component, 80)).slice(0, 1)).toEqual(["1 index.ts"]);
		await component.handleInput("-");
		expect((await renderPlain(component, 80)).slice(0, 2)).toEqual(["1 src/", "2 readme.md"]);
	});

	it("'-' at the resolved root is a no-op -- v1 never widens scope above it", async () => {
		const tui = fakeTui();
		const component = new ExplorerComponent(tui, fakeTheme, fakeSession(fakeTree()), "", () => undefined);
		await tick();
		await component.handleInput("-");
		expect((await renderPlain(component, 80)).slice(0, 2)).toEqual(["1 src/", "2 readme.md"]);
	});

	it(":w with no edits reports 'no changes' and never asks for confirmation", async () => {
		const tui = fakeTui();
		const component = new ExplorerComponent(tui, fakeTheme, fakeSession(fakeTree()), "", () => undefined);
		await tick();
		for (const key of [":", "w", "\r"]) await component.handleInput(key);
		expect(component.render(80).at(-1)).toContain("no changes");
	});

	it(":w after a rename shows a confirmation summary before applying anything", async () => {
		const tree = fakeTree();
		const tui = fakeTui();
		const component = new ExplorerComponent(tui, fakeTheme, fakeSession(tree), "", () => undefined);
		await tick();
		// Rename readme.md -> README.md: move to line 2, enter insert at end, uppercase the name.
		await component.handleInput("j");
		await component.handleInput("$");
		await component.handleInput("a");
		for (const key of ["\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "\x7f", "R", "E", "A", "D", "M", "E", ".", "m", "d"]) {
			await component.handleInput(key);
		}
		await component.handleInput("\x1b"); // back to normal
		for (const key of [":", "w", "\r"]) await component.handleInput(key);

		const rendered = component.render(80);
		expect(rendered).toContain("Pending changes:");
		expect(rendered.some((line) => line.includes("readme.md -> README.md"))).toBe(true);
		// Not applied yet -- the real tree must be untouched until confirmed.
		expect(tree.has("readme.md")).toBe(true);
	});

	it("confirming with 'y' applies the diff for real and reloads the listing", async () => {
		const tree = fakeTree();
		const tui = fakeTui();
		const component = new ExplorerComponent(tui, fakeTheme, fakeSession(tree), "", () => undefined);
		await tick();
		await component.handleInput("d");
		await component.handleInput("d"); // dd deletes the cursor line (src/)
		for (const key of [":", "w", "\r"]) await component.handleInput(key);
		expect(component.render(80)).toContain("Pending changes:");

		await component.handleInput("y");
		expect(tree.has("src")).toBe(false);
		expect(component.render(80).some((line) => line.includes("no changes") === false)).toBe(true);
	});

	it("cancelling confirmation with 'n' leaves the real tree untouched and returns to editing", async () => {
		const tree = fakeTree();
		const tui = fakeTui();
		const component = new ExplorerComponent(tui, fakeTheme, fakeSession(tree), "", () => undefined);
		await tick();
		await component.handleInput("d");
		await component.handleInput("d");
		for (const key of [":", "w", "\r"]) await component.handleInput(key);
		expect(component.render(80)).toContain("Pending changes:");

		await component.handleInput("n");
		expect(tree.has("src")).toBe(true);
		expect(component.render(80)).not.toContain("Pending changes:");
	});

	it(":q calls done() with a quit result", async () => {
		const tui = fakeTui();
		let result: ExplorerResult | undefined;
		const component = new ExplorerComponent(tui, fakeTheme, fakeSession(fakeTree()), "", (r) => {
			result = r;
		});
		await tick();
		for (const key of [":", "q", "\r"]) await component.handleInput(key);
		expect(result).toEqual({ kind: "quit", viewState: { relativePath: "", selectedEntryName: "src" } });
	});
});
