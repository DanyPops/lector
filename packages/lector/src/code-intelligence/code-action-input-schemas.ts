import { defineVehicleSchema, isNonEmptyString, isPositiveSafeInteger, notAnObjectIssue, schemaIssue, type VehicleSchemaCodec } from "@danypops/vehicle-core";
import type { OperationInputs } from "../service/operations.ts";
import { codeActionPreviewId } from "./code-action.ts";
import type { Diagnostic, DiagnosticSeverity } from "./diagnostic.ts";

type ParseFailure = ReturnType<typeof schemaIssue>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function severity(value: unknown): DiagnosticSeverity | undefined {
	if (value === "error" || value === "warning" || value === "information" || value === "hint") return value;
	return undefined;
}

function position(value: unknown, field: string): { line: number; character: number } | ParseFailure {
	if (!isRecord(value)) return schemaIssue([field], `${field} must be an object`);
	if (!isPositiveSafeInteger(value.line)) return schemaIssue([field, "line"], "line must be a positive safe integer");
	if (!isPositiveSafeInteger(value.character)) return schemaIssue([field, "character"], "character must be a positive safe integer");
	return { line: value.line, character: value.character };
}

function failed<T>(value: T | ParseFailure): value is ParseFailure {
	return isRecord(value) && value.success === false;
}

function diagnostics(value: unknown): readonly Diagnostic[] | ParseFailure {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length > 1_000) return schemaIssue(["diagnostics"], "diagnostics must contain at most 1000 entries");
	const parsed: Diagnostic[] = [];
	for (let index = 0; index < value.length; index += 1) {
		const item: unknown = value[index];
		if (!isRecord(item) || !isRecord(item.range)) return schemaIssue(["diagnostics", index], "diagnostic must contain a range");
		const itemSeverity = severity(item.severity);
		if (!isNonEmptyString(item.range.path) || itemSeverity === undefined || typeof item.message !== "string") {
			return schemaIssue(["diagnostics", index], "diagnostic path, severity, and message are invalid");
		}
		const start = position(item.range.start, `diagnostics.${index}.range.start`);
		if (failed(start)) return start;
		const end = position(item.range.end, `diagnostics.${index}.range.end`);
		if (failed(end)) return end;
		if (item.source !== undefined && typeof item.source !== "string") return schemaIssue(["diagnostics", index, "source"], "source must be a string");
		if (item.code !== undefined && typeof item.code !== "string" && typeof item.code !== "number") {
			return schemaIssue(["diagnostics", index, "code"], "code must be a string or number");
		}
		parsed.push({
			range: { path: item.range.path, start, end },
			severity: itemSeverity,
			message: item.message,
			...(item.source !== undefined ? { source: item.source } : {}),
			...(item.code !== undefined ? { code: item.code } : {}),
		});
	}
	return parsed;
}

export const previewCodeActionsInputSchema: VehicleSchemaCodec<OperationInputs["workspace.previewCodeActions"]> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: {
			workspaceId: { type: "string" },
			path: { type: "string" },
			range: { type: "object" },
			diagnostics: { type: "array", maxItems: 1_000 },
			only: { type: "array", maxItems: 20 },
			includeCommandActions: { type: "boolean" },
			maxActions: { type: "number" },
			maxEdits: { type: "number" },
			maxFiles: { type: "number" },
			maxBytes: { type: "number" },
			deadlineMs: { type: "number" },
		},
		required: ["workspaceId", "path", "range", "maxActions", "maxEdits", "maxFiles", "maxBytes", "deadlineMs"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isRecord(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue(["workspaceId"], "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.path)) return schemaIssue(["path"], "path must be a non-empty string");
		if (!isRecord(value.range)) return schemaIssue(["range"], "range must be an object");
		const start = position(value.range.start, "range.start");
		if (failed(start)) return start;
		const end = position(value.range.end, "range.end");
		if (failed(end)) return end;
		const parsedDiagnostics = diagnostics(value.diagnostics);
		if (failed(parsedDiagnostics)) return parsedDiagnostics;
		let only: string[] | undefined;
		if (value.only !== undefined) {
			if (!Array.isArray(value.only) || value.only.length > 20) return schemaIssue(["only"], "only must contain at most 20 non-empty strings");
			only = [];
			for (const kind of value.only) {
				if (!isNonEmptyString(kind)) return schemaIssue(["only"], "only must contain at most 20 non-empty strings");
				only.push(kind);
			}
		}
		if (value.includeCommandActions !== undefined && typeof value.includeCommandActions !== "boolean") {
			return schemaIssue(["includeCommandActions"], "includeCommandActions must be a boolean");
		}
		const { maxActions, maxEdits, maxFiles, maxBytes, deadlineMs } = value;
		if (!isPositiveSafeInteger(maxActions)) return schemaIssue(["maxActions"], "maxActions must be a positive safe integer");
		if (!isPositiveSafeInteger(maxEdits)) return schemaIssue(["maxEdits"], "maxEdits must be a positive safe integer");
		if (!isPositiveSafeInteger(maxFiles)) return schemaIssue(["maxFiles"], "maxFiles must be a positive safe integer");
		if (!isPositiveSafeInteger(maxBytes)) return schemaIssue(["maxBytes"], "maxBytes must be a positive safe integer");
		if (!isPositiveSafeInteger(deadlineMs)) return schemaIssue(["deadlineMs"], "deadlineMs must be a positive safe integer");
		return {
			success: true,
			value: {
				workspaceId: value.workspaceId,
				path: value.path,
				range: { start, end },
				...(value.diagnostics !== undefined ? { diagnostics: parsedDiagnostics } : {}),
				...(only ? { only } : {}),
				...(value.includeCommandActions !== undefined ? { includeCommandActions: value.includeCommandActions } : {}),
				maxActions,
				maxEdits,
				maxFiles,
				maxBytes,
				deadlineMs,
			},
		};
	},
});

export const applyCodeActionInputSchema: VehicleSchemaCodec<OperationInputs["workspace.applyCodeAction"]> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, previewId: { type: "string" } },
		required: ["workspaceId", "previewId"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isRecord(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue(["workspaceId"], "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.previewId)) return schemaIssue(["previewId"], "previewId must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId, previewId: codeActionPreviewId(value.previewId) } };
	},
});
