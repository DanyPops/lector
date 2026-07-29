import { describe, expect, it } from "bun:test";
import { parseServerCapabilities, shouldSyncDocuments } from "../../src/domain/lsp-server-capabilities.ts";

describe("parseServerCapabilities", () => {
	it("defaults every field when capabilities is empty or malformed", () => {
		for (const raw of [{}, null, undefined, "not an object", 42]) {
			expect(parseServerCapabilities(raw)).toEqual({
				positionEncoding: "utf-16",
				textDocumentSyncKind: "none",
				renameProvider: false,
				prepareRenameProvider: false,
				workspaceFileOperations: { willRename: false, didRename: false, willDelete: false, didDelete: false, willCreate: false, didCreate: false },
				diagnosticProvider: undefined,
			});
		}
	});

	it("reads a declared positionEncoding, defaulting to utf-16 only when absent", () => {
		expect(parseServerCapabilities({ positionEncoding: "utf-8" }).positionEncoding).toBe("utf-8");
		expect(parseServerCapabilities({ positionEncoding: "utf-32" }).positionEncoding).toBe("utf-32");
		expect(parseServerCapabilities({ positionEncoding: "bogus" }).positionEncoding).toBe("utf-16");
	});

	it("parses textDocumentSync as a raw number or as an object's .change field", () => {
		expect(parseServerCapabilities({ textDocumentSync: 1 }).textDocumentSyncKind).toBe("full");
		expect(parseServerCapabilities({ textDocumentSync: 2 }).textDocumentSyncKind).toBe("incremental");
		expect(parseServerCapabilities({ textDocumentSync: { change: 2, openClose: true } }).textDocumentSyncKind).toBe("incremental");
		expect(parseServerCapabilities({ textDocumentSync: 0 }).textDocumentSyncKind).toBe("none");
	});

	it("treats renameProvider true or an options object as supported, and reads prepareProvider only from the options object", () => {
		expect(parseServerCapabilities({ renameProvider: true }).renameProvider).toBe(true);
		expect(parseServerCapabilities({ renameProvider: true }).prepareRenameProvider).toBe(false);
		expect(parseServerCapabilities({ renameProvider: { prepareProvider: true } }).renameProvider).toBe(true);
		expect(parseServerCapabilities({ renameProvider: { prepareProvider: true } }).prepareRenameProvider).toBe(true);
		expect(parseServerCapabilities({ renameProvider: false }).renameProvider).toBe(false);
	});

	it("reads workspace file-operation capabilities by presence, not by their (often empty) options object", () => {
		const capabilities = parseServerCapabilities({ workspace: { fileOperations: { willRename: {}, didRename: {} } } });
		expect(capabilities.workspaceFileOperations).toEqual({
			willRename: true,
			didRename: true,
			willDelete: false,
			didDelete: false,
			willCreate: false,
			didCreate: false,
		});
	});

	it("distinguishes a server that never declared pull diagnostics from one that declared it with both flags false", () => {
		expect(parseServerCapabilities({}).diagnosticProvider).toBeUndefined();
		expect(parseServerCapabilities({ diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false } }).diagnosticProvider).toEqual({
			interFileDependencies: false,
			workspaceDiagnostics: false,
		});
		expect(parseServerCapabilities({ diagnosticProvider: { interFileDependencies: true, workspaceDiagnostics: true } }).diagnosticProvider).toEqual({
			interFileDependencies: true,
			workspaceDiagnostics: true,
		});
	});
});

describe("shouldSyncDocuments", () => {
	it("sends sync notifications for full", () => {
		expect(shouldSyncDocuments("full")).toBe(true);
	});

	it("sends sync notifications for incremental -- this client only ever sends Full-content changes regardless, which is spec-legal for an incremental-only server too", () => {
		expect(shouldSyncDocuments("incremental")).toBe(true);
	});

	it("skips sync notifications for none -- the server told the client (explicitly, or by omitting the field per spec default) it does not track document content this way", () => {
		expect(shouldSyncDocuments("none")).toBe(false);
	});
});
