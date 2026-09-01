import { defineVehicleSchema, isNonEmptyString, isPlainObject, notAnObjectIssue, schemaIssue, type VehicleSchemaCodec } from "@danypops/vehicle-core";

export interface WorkspaceReleaseInput {
	readonly workspaceId: string;
}

/** Validates the explicit opaque workspace identity required by workspace.release. */
export const workspaceReleaseInputSchema: VehicleSchemaCodec<WorkspaceReleaseInput> = defineVehicleSchema({
	jsonSchema: {
		type: "object",
		properties: { workspaceId: { type: "string" } },
		required: ["workspaceId"],
		additionalProperties: false,
	},
	safeParse(value) {
		if (!isPlainObject(value)) return notAnObjectIssue();
		if (!isNonEmptyString(value.workspaceId)) return schemaIssue("workspaceId", "workspaceId must be a non-empty string");
		return { success: true, value: { workspaceId: value.workspaceId } };
	},
});
