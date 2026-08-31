/** Runtime schemas narrow annotation anchors, filters, and traversal bounds before dispatch. */
import {
	defineVehicleSchema,
	isNonEmptyString,
	isNonNegativeSafeInteger,
	isPlainObject,
	isPositiveSafeInteger,
	isSafeInteger,
	notAnObjectIssue,
	schemaIssue,
	type VehicleSchemaCodec,
	type VehicleSchemaIssue,
} from "@danypops/vehicle-core";

export interface AnnotationPosition {
	readonly path: string;
	readonly line: number;
	readonly character: number;
}

export interface CreateAnnotationInput {
	readonly workspaceId: string;
	readonly subtype: string;
	readonly title: string;
	readonly body: string;
	readonly anchors: readonly AnnotationPosition[];
	readonly autoPopulate?: boolean;
	readonly maxFiles?: number;
	readonly maxSymbolsPerFile?: number;
}

export interface GetAnnotationInput {
	readonly workspaceId: string;
	readonly id: string;
}

export type AnnotationStatusFilter = "fresh" | "stale" | "scrubbed";

export interface ListAnnotationsInput {
	readonly workspaceId: string;
	readonly subtype?: string;
	readonly status?: AnnotationStatusFilter;
	readonly maxResults?: number;
	readonly query?: string;
}

export interface RefreshAnnotationInput {
	readonly workspaceId: string;
	readonly id: string;
	readonly subtype: string;
	readonly title: string;
	readonly body: string;
	readonly anchors: readonly AnnotationPosition[];
	readonly autoPopulate?: boolean;
	readonly maxFiles?: number;
	readonly maxSymbolsPerFile?: number;
}

export interface ScrubAnnotationInput {
	readonly workspaceId: string;
	readonly id: string;
}

export interface RestoreAnnotationInput {
	readonly workspaceId: string;
	readonly id: string;
}

export interface ContainAnnotationInput {
	readonly workspaceId: string;
	readonly parentId: string;
	readonly childId: string;
}

export interface UncontainAnnotationInput {
	readonly workspaceId: string;
	readonly parentId: string;
	readonly childId: string;
}

export interface AnnotationTreeInput {
	readonly workspaceId: string;
	readonly rootId: string;
	readonly maxDepth: number;
}

type ParseFailure = { readonly success: false; readonly issues: readonly VehicleSchemaIssue[] };

/** anchors: a non-empty array of {path, line, character} -- emptiness itself is a domain rule (AnnotationRequiresAnchors), enforced by the handler, not this schema; this only narrows each element's own shape. */
function parseAnchors(value: unknown): readonly AnnotationPosition[] | ParseFailure {
	if (!Array.isArray(value)) return schemaIssue(["anchors"], "anchors must be an array");
	const anchors: AnnotationPosition[] = [];
	for (const [index, element] of value.entries()) {
		if (!isPlainObject(element)) return schemaIssue(["anchors", index], "each anchor must be an object");
		if (!isNonEmptyString(element.path)) return schemaIssue(["anchors", index, "path"], "path must be a non-empty string");
		if (!isSafeInteger(element.line)) return schemaIssue(["anchors", index, "line"], "line must be a safe integer");
		if (!isSafeInteger(element.character)) return schemaIssue(["anchors", index, "character"], "character must be a safe integer");
		anchors.push({ path: element.path, line: element.line, character: element.character });
	}
	return anchors;
}

function isParseFailure(value: unknown): value is ParseFailure {
	return isPlainObject(value) && value.success === false;
}

export const createAnnotationInputSchema: VehicleSchemaCodec<CreateAnnotationInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: {
			workspaceId: { type: "string" },
			subtype: { type: "string" },
			title: { type: "string" },
			body: { type: "string" },
			anchors: { type: "array" },
			autoPopulate: { type: "boolean" },
			maxFiles: { type: "number" },
			maxSymbolsPerFile: { type: "number" },
		},
		required: ["workspaceId", "subtype", "title", "body", "anchors"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue(["workspaceId"], "workspaceId must be a non-empty string");
		if (typeof value.subtype !== "string" || value.subtype.length === 0) return schemaIssue(["subtype"], "subtype must be a non-empty string");
		if (typeof value.title !== "string") return schemaIssue(["title"], "title must be a string");
		if (typeof value.body !== "string") return schemaIssue(["body"], "body must be a string");
		const anchors = parseAnchors(value.anchors);
		if (isParseFailure(anchors)) return anchors;
		if (value.autoPopulate !== undefined && typeof value.autoPopulate !== "boolean") return schemaIssue(["autoPopulate"], "autoPopulate must be a boolean");
		if (value.maxFiles !== undefined && !isPositiveSafeInteger(value.maxFiles)) return schemaIssue(["maxFiles"], "maxFiles must be a positive safe integer");
		if (value.maxSymbolsPerFile !== undefined && !isPositiveSafeInteger(value.maxSymbolsPerFile))
			return schemaIssue(["maxSymbolsPerFile"], "maxSymbolsPerFile must be a positive safe integer");
		return {
			success: true,
			value: {
				workspaceId: value.workspaceId,
				subtype: value.subtype,
				title: value.title,
				body: value.body,
				anchors,
				...(value.autoPopulate !== undefined ? { autoPopulate: value.autoPopulate } : {}),
				...(value.maxFiles !== undefined ? { maxFiles: value.maxFiles } : {}),
				...(value.maxSymbolsPerFile !== undefined ? { maxSymbolsPerFile: value.maxSymbolsPerFile } : {}),
			},
		};
	},
});

export const getAnnotationInputSchema: VehicleSchemaCodec<GetAnnotationInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, id: { type: "string" } },
		required: ["workspaceId", "id"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue(["workspaceId"], "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.id)) return schemaIssue(["id"], "id must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId, id: value.id } };
	},
});

const ANNOTATION_STATUS_VALUES: readonly AnnotationStatusFilter[] = ["fresh", "stale", "scrubbed"];

function isStatusFilter(value: unknown): value is AnnotationStatusFilter {
	return typeof value === "string" && (ANNOTATION_STATUS_VALUES as readonly string[]).includes(value);
}

export const listAnnotationsInputSchema: VehicleSchemaCodec<ListAnnotationsInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: {
			workspaceId: { type: "string" },
			subtype: { type: "string" },
			status: { type: "string", enum: ANNOTATION_STATUS_VALUES },
			maxResults: { type: "number" },
			query: { type: "string" },
		},
		required: ["workspaceId"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue(["workspaceId"], "workspaceId must be a non-empty string");
		if (value.subtype !== undefined && typeof value.subtype !== "string") return schemaIssue(["subtype"], "subtype must be a string when given");
		if (value.status !== undefined && !isStatusFilter(value.status)) {
			return schemaIssue(["status"], `status must be one of ${ANNOTATION_STATUS_VALUES.join(", ")} when given`);
		}
		if (value.maxResults !== undefined && !isPositiveSafeInteger(value.maxResults))
			return schemaIssue(["maxResults"], "maxResults must be a positive safe integer when given");
		if (value.query !== undefined && typeof value.query !== "string") return schemaIssue(["query"], "query must be a string when given");
		return {
			success: true,
			value: { workspaceId: value.workspaceId, subtype: value.subtype, status: value.status, maxResults: value.maxResults, query: value.query },
		};
	},
});

export const refreshAnnotationInputSchema: VehicleSchemaCodec<RefreshAnnotationInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: {
			workspaceId: { type: "string" },
			id: { type: "string" },
			subtype: { type: "string" },
			title: { type: "string" },
			body: { type: "string" },
			anchors: { type: "array" },
			autoPopulate: { type: "boolean" },
			maxFiles: { type: "number" },
			maxSymbolsPerFile: { type: "number" },
		},
		required: ["workspaceId", "id", "subtype", "title", "body", "anchors"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue(["workspaceId"], "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.id)) return schemaIssue(["id"], "id must be a non-empty string");
		if (typeof value.subtype !== "string" || value.subtype.length === 0) return schemaIssue(["subtype"], "subtype must be a non-empty string");
		if (typeof value.title !== "string") return schemaIssue(["title"], "title must be a string");
		if (typeof value.body !== "string") return schemaIssue(["body"], "body must be a string");
		const anchors = parseAnchors(value.anchors);
		if (isParseFailure(anchors)) return anchors;
		if (value.autoPopulate !== undefined && typeof value.autoPopulate !== "boolean") return schemaIssue(["autoPopulate"], "autoPopulate must be a boolean");
		if (value.maxFiles !== undefined && !isPositiveSafeInteger(value.maxFiles)) return schemaIssue(["maxFiles"], "maxFiles must be a positive safe integer");
		if (value.maxSymbolsPerFile !== undefined && !isPositiveSafeInteger(value.maxSymbolsPerFile))
			return schemaIssue(["maxSymbolsPerFile"], "maxSymbolsPerFile must be a positive safe integer");
		return {
			success: true,
			value: {
				workspaceId: value.workspaceId,
				id: value.id,
				subtype: value.subtype,
				title: value.title,
				body: value.body,
				anchors,
				...(value.autoPopulate !== undefined ? { autoPopulate: value.autoPopulate } : {}),
				...(value.maxFiles !== undefined ? { maxFiles: value.maxFiles } : {}),
				...(value.maxSymbolsPerFile !== undefined ? { maxSymbolsPerFile: value.maxSymbolsPerFile } : {}),
			},
		};
	},
});

export const scrubAnnotationInputSchema: VehicleSchemaCodec<ScrubAnnotationInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, id: { type: "string" } },
		required: ["workspaceId", "id"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue(["workspaceId"], "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.id)) return schemaIssue(["id"], "id must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId, id: value.id } };
	},
});

export const restoreAnnotationInputSchema: VehicleSchemaCodec<RestoreAnnotationInput> = scrubAnnotationInputSchema;

export const containAnnotationInputSchema: VehicleSchemaCodec<ContainAnnotationInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, parentId: { type: "string" }, childId: { type: "string" } },
		required: ["workspaceId", "parentId", "childId"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue(["workspaceId"], "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.parentId)) return schemaIssue(["parentId"], "parentId must be a non-empty string");
		if (!isNonEmptyString(value.childId)) return schemaIssue(["childId"], "childId must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId, parentId: value.parentId, childId: value.childId } };
	},
});

export const uncontainAnnotationInputSchema: VehicleSchemaCodec<UncontainAnnotationInput> = containAnnotationInputSchema;

export const annotationTreeInputSchema: VehicleSchemaCodec<AnnotationTreeInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" }, rootId: { type: "string" }, maxDepth: { type: "number" } },
		required: ["workspaceId", "rootId", "maxDepth"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue(["workspaceId"], "workspaceId must be a non-empty string");
		if (!isNonEmptyString(value.rootId)) return schemaIssue(["rootId"], "rootId must be a non-empty string");
		if (!isNonNegativeSafeInteger(value.maxDepth)) return schemaIssue(["maxDepth"], "maxDepth must be a non-negative safe integer");
		return { success: true, value: { workspaceId: value.workspaceId, rootId: value.rootId, maxDepth: value.maxDepth } };
	},
});
