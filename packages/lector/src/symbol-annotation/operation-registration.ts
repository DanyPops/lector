/** Annotation creation is unsafe to retry because each successful call creates a distinct identity. */
import { bindVehicleOperation, defineErrorMapping, defineVehicleOperation, passthroughVehicleSchema } from "@danypops/vehicle-core";
import type { VehicleRegistry } from "@danypops/vehicle-server";
import { WORKSPACE_READ_PERMISSION, WORKSPACE_WRITE_PERMISSION } from "../operation-dispatch/permissions.ts";
import { UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR, UNKNOWN_WORKSPACE_ERROR_MAPPING } from "../operation-dispatch/workspace-errors.ts";
import type { AnnotationHandlers } from "../service/annotation-handlers.ts";
import { AnnotationContainmentCycle, AnnotationRequiresAnchors, UnknownAnnotationAnchor, UnknownAnnotationForContainment } from "../service/errors.ts";
import type { MutableRegistry } from "../service/workspace-registry.ts";
import {
	annotationTreeInputSchema,
	containAnnotationInputSchema,
	createAnnotationInputSchema,
	getAnnotationInputSchema,
	listAnnotationsInputSchema,
	refreshAnnotationInputSchema,
	restoreAnnotationInputSchema,
	scrubAnnotationInputSchema,
	uncontainAnnotationInputSchema,
} from "./input-schemas.ts";

const OWNER = "lector-annotation";

const READ_PERMISSIONS = [WORKSPACE_READ_PERMISSION];
const WRITE_PERMISSIONS = [WORKSPACE_WRITE_PERMISSION];

const LIMITS = { defaultTimeoutMs: 5_000, maxTimeoutMs: 30_000, maxRequestBytes: 65_536, maxResponseBytes: 262_144 };

const REQUIRES_ANCHORS_ERROR = { code: "annotation-requires-anchors", description: "an annotation requires at least one anchor" };
const UNKNOWN_ANCHOR_ERROR = { code: "unknown-annotation-anchor", description: "an anchor position does not resolve to a real, currently-known symbol" };
const UNKNOWN_CONTAINMENT_ERROR = { code: "unknown-annotation-for-containment", description: "parentId or childId does not name an existing annotation" };
const CONTAINMENT_CYCLE_ERROR = { code: "annotation-containment-cycle", description: "the requested containment would create a cycle" };

const ANCHOR_ERRORS = [UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR, REQUIRES_ANCHORS_ERROR, UNKNOWN_ANCHOR_ERROR];
const WORKSPACE_ONLY_ERRORS = [UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR];
const CONTAINMENT_ERRORS = [UNKNOWN_WORKSPACE_ERROR_DESCRIPTOR, UNKNOWN_CONTAINMENT_ERROR, CONTAINMENT_CYCLE_ERROR];

/** Maps every real domain error these 9 operations can throw onto a coded/categorized VehicleError, preserving the original as `cause`. */
const mapAnnotationError = defineErrorMapping([
	UNKNOWN_WORKSPACE_ERROR_MAPPING,
	{ errorClass: AnnotationRequiresAnchors, category: "validation", code: "annotation-requires-anchors" },
	{ errorClass: UnknownAnnotationAnchor, category: "not_found", code: "unknown-annotation-anchor" },
	{ errorClass: UnknownAnnotationForContainment, category: "not_found", code: "unknown-annotation-for-containment" },
	{ errorClass: AnnotationContainmentCycle, category: "conflict", code: "annotation-containment-cycle" },
]);

/** Registers annotation contracts without duplicating AnnotationHandlers behavior. */
export function registerAnnotationOperations(operationRegistry: VehicleRegistry, registry: MutableRegistry, handlers: AnnotationHandlers): void {
	const createAnnotation = defineVehicleOperation({
		name: "workspace.createAnnotation",
		version: 1,
		description: "Creates a new annotation anchored to one or more symbol positions.",
		input: createAnnotationInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "local-write",
		idempotency: { mode: "unsafe" },
		limits: LIMITS,
		errors: ANCHOR_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(
			createAnnotation,
			() => (context) => mapAnnotationError(() => handlers.handlers["workspace.createAnnotation"](registry, context.input)),
		),
	);

	const getAnnotation = defineVehicleOperation({
		name: "workspace.getAnnotation",
		version: 1,
		description: "Gets one annotation by id, with its staleness status refreshed against the live graph.",
		input: getAnnotationInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: WORKSPACE_ONLY_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(getAnnotation, () => (context) => mapAnnotationError(() => handlers.handlers["workspace.getAnnotation"](registry, context.input))),
	);

	const listAnnotations = defineVehicleOperation({
		name: "workspace.listAnnotations",
		version: 1,
		description: "Lists annotations, filtered by subtype/status/free-text and bounded by maxResults.",
		input: listAnnotationsInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: WORKSPACE_ONLY_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(listAnnotations, () => (context) => mapAnnotationError(() => handlers.handlers["workspace.listAnnotations"](registry, context.input))),
	);

	const refreshAnnotation = defineVehicleOperation({
		name: "workspace.refreshAnnotation",
		version: 1,
		description: "Re-authors an annotation's body/anchors, resetting its status to fresh.",
		input: refreshAnnotationInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "local-write",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: ANCHOR_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(
			refreshAnnotation,
			() => (context) => mapAnnotationError(() => handlers.handlers["workspace.refreshAnnotation"](registry, context.input)),
		),
	);

	const scrubAnnotation = defineVehicleOperation({
		name: "workspace.scrubAnnotation",
		version: 1,
		description: "Soft-deletes an annotation -- excluded from list() by default, still restorable.",
		input: scrubAnnotationInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "local-write",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: WORKSPACE_ONLY_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(scrubAnnotation, () => (context) => mapAnnotationError(() => handlers.handlers["workspace.scrubAnnotation"](registry, context.input))),
	);

	const restoreAnnotation = defineVehicleOperation({
		name: "workspace.restoreAnnotation",
		version: 1,
		description: "Restores a scrubbed annotation to stale.",
		input: restoreAnnotationInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "local-write",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: WORKSPACE_ONLY_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(
			restoreAnnotation,
			() => (context) => mapAnnotationError(() => handlers.handlers["workspace.restoreAnnotation"](registry, context.input)),
		),
	);

	const containAnnotation = defineVehicleOperation({
		name: "workspace.containAnnotation",
		version: 1,
		description: "Makes one annotation a child of another, rejecting a cycle up front.",
		input: containAnnotationInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "local-write",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: CONTAINMENT_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(
			containAnnotation,
			() => (context) => mapAnnotationError(() => handlers.handlers["workspace.containAnnotation"](registry, context.input)),
		),
	);

	const uncontainAnnotation = defineVehicleOperation({
		name: "workspace.uncontainAnnotation",
		version: 1,
		description: "Removes a containment relationship between two annotations.",
		input: uncontainAnnotationInputSchema,
		output: passthroughVehicleSchema,
		permissions: WRITE_PERMISSIONS,
		effect: "local-write",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: WORKSPACE_ONLY_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(
			uncontainAnnotation,
			() => (context) => mapAnnotationError(() => handlers.handlers["workspace.uncontainAnnotation"](registry, context.input)),
		),
	);

	const annotationTree = defineVehicleOperation({
		name: "workspace.annotationTree",
		version: 1,
		description: "Reads a bounded containment subtree rooted at one annotation.",
		input: annotationTreeInputSchema,
		output: passthroughVehicleSchema,
		permissions: READ_PERMISSIONS,
		effect: "read",
		idempotency: { mode: "safe" },
		limits: LIMITS,
		errors: WORKSPACE_ONLY_ERRORS,
	});
	operationRegistry.register(
		OWNER,
		bindVehicleOperation(annotationTree, () => (context) => mapAnnotationError(() => handlers.handlers["workspace.annotationTree"](registry, context.input))),
	);
}

export { READ_PERMISSIONS as ANNOTATION_READ_PERMISSIONS, WRITE_PERMISSIONS as ANNOTATION_WRITE_PERMISSIONS };
