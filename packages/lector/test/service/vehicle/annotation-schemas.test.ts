/** Each schema's safeParse success/failure branches, without spinning up a registry or workspace. */
import { describe, expect, it } from "bun:test";
import {
	annotationTreeInputSchema,
	containAnnotationInputSchema,
	createAnnotationInputSchema,
	listAnnotationsInputSchema,
} from "../../../src/service/vehicle/annotation-schemas.ts";

describe("createAnnotationInputSchema", () => {
	it("accepts a valid annotation with one anchor", () => {
		const input = { workspaceId: "ws", subtype: "comment", title: "t", body: "b", anchors: [{ path: "a.ts", line: 1, character: 2 }] };
		expect(createAnnotationInputSchema.safeParse(input)).toEqual({ success: true, value: input });
	});

	it("accepts an empty anchors array -- emptiness is a handler-level domain rule, not a schema rule", () => {
		const input = { workspaceId: "ws", subtype: "comment", title: "t", body: "b", anchors: [] };
		expect(createAnnotationInputSchema.safeParse(input)).toEqual({ success: true, value: input });
	});

	it("rejects a non-array anchors field", () => {
		const result = createAnnotationInputSchema.safeParse({ workspaceId: "ws", subtype: "c", title: "t", body: "b", anchors: "nope" });
		expect(result).toEqual({ success: false, issues: [{ path: ["anchors"], message: "anchors must be an array" }] });
	});

	it("rejects an anchor element missing a required field, reporting its exact index", () => {
		const input = { workspaceId: "ws", subtype: "c", title: "t", body: "b", anchors: [{ path: "a.ts", line: 1 }] };
		const result = createAnnotationInputSchema.safeParse(input);
		expect(result).toEqual({ success: false, issues: [{ path: ["anchors", 0, "character"], message: "character must be a safe integer" }] });
	});

	it("rejects an empty subtype", () => {
		const result = createAnnotationInputSchema.safeParse({ workspaceId: "ws", subtype: "", title: "t", body: "b", anchors: [] });
		expect(result).toEqual({ success: false, issues: [{ path: ["subtype"], message: "subtype must be a non-empty string" }] });
	});
});

describe("listAnnotationsInputSchema", () => {
	it("accepts just workspaceId -- every filter field is optional", () => {
		expect(listAnnotationsInputSchema.safeParse({ workspaceId: "ws" })).toEqual({
			success: true,
			value: { workspaceId: "ws", subtype: undefined, status: undefined, maxResults: undefined, query: undefined },
		});
	});

	it("accepts a valid status enum value", () => {
		const result = listAnnotationsInputSchema.safeParse({ workspaceId: "ws", status: "stale" });
		expect(result).toEqual({ success: true, value: { workspaceId: "ws", subtype: undefined, status: "stale", maxResults: undefined, query: undefined } });
	});

	it("rejects a status value outside the real enum", () => {
		const result = listAnnotationsInputSchema.safeParse({ workspaceId: "ws", status: "deleted" });
		expect(result).toEqual({ success: false, issues: [{ path: ["status"], message: "status must be one of fresh, stale, scrubbed when given" }] });
	});

	it("rejects a zero maxResults", () => {
		const result = listAnnotationsInputSchema.safeParse({ workspaceId: "ws", maxResults: 0 });
		expect(result).toEqual({ success: false, issues: [{ path: ["maxResults"], message: "maxResults must be a positive safe integer when given" }] });
	});
});

describe("containAnnotationInputSchema", () => {
	it("accepts a valid parentId/childId pair", () => {
		const input = { workspaceId: "ws", parentId: "p", childId: "c" };
		expect(containAnnotationInputSchema.safeParse(input)).toEqual({ success: true, value: input });
	});

	it("rejects a missing childId", () => {
		const result = containAnnotationInputSchema.safeParse({ workspaceId: "ws", parentId: "p" });
		expect(result).toEqual({ success: false, issues: [{ path: ["childId"], message: "childId must be a non-empty string" }] });
	});
});

describe("annotationTreeInputSchema", () => {
	it("accepts maxDepth: 0 -- root only, a real valid case, not merely a positive bound", () => {
		const input = { workspaceId: "ws", rootId: "r", maxDepth: 0 };
		expect(annotationTreeInputSchema.safeParse(input)).toEqual({ success: true, value: input });
	});

	it("rejects a negative maxDepth", () => {
		const result = annotationTreeInputSchema.safeParse({ workspaceId: "ws", rootId: "r", maxDepth: -1 });
		expect(result).toEqual({ success: false, issues: [{ path: ["maxDepth"], message: "maxDepth must be a non-negative safe integer" }] });
	});
});
