import { connectLectorClient } from "../../../client.ts";
import { fail, flagValue, hasFlag, requireAnnotationFields } from "../../flags.ts";
import { formatAnnotation } from "../../format.ts";
import { USAGE } from "../../usage.ts";

/** createAnnotation/getAnnotation/listAnnotations/refreshAnnotation/scrubAnnotation/restoreAnnotation/containAnnotation/uncontainAnnotation/annotationTree -- mirrors service/annotation-handlers.ts's own scope. Its own subcommand dispatcher (WORKSPACE_ANNOTATION_ACTIONS) is one level deeper than every other workspace action -- `lector workspace annotation <subcommand> ...`, not `lector workspace <action> ...`. */

export async function runWorkspaceAnnotationCreate(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const { subtype, title, body, anchors } = requireAnnotationFields(flags);
	const client = await connectLectorClient();
	const { annotation } = await client.call("workspace.createAnnotation", { workspaceId, subtype, title, body, anchors });
	console.log(hasFlag(flags, "--json") ? JSON.stringify(annotation) : formatAnnotation(annotation));
}

export async function runWorkspaceAnnotationGet(workspaceId: string | undefined, id: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !id) fail(USAGE);
	const client = await connectLectorClient();
	const { annotation } = await client.call("workspace.getAnnotation", { workspaceId, id });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(annotation ?? null));
		return;
	}
	console.log(annotation ? formatAnnotation(annotation) : `no annotation "${id}" in workspace "${workspaceId}"`);
}

export async function runWorkspaceAnnotationList(workspaceId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId) fail(USAGE);
	const subtype = flagValue(flags, "--subtype");
	const statusFlag = flagValue(flags, "--status");
	// A raw CLI flag; the daemon rejects an invalid value with a clear domain error either way.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	const status = statusFlag as "fresh" | "stale" | "scrubbed" | undefined;
	const maxResultsFlagValue = flagValue(flags, "--max-results");
	const maxResults = maxResultsFlagValue === undefined ? undefined : Number(maxResultsFlagValue);
	const query = flagValue(flags, "--query");
	const client = await connectLectorClient();
	const { annotations } = await client.call("workspace.listAnnotations", { workspaceId, subtype, status, maxResults, query });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(annotations));
		return;
	}
	if (annotations.length === 0) {
		console.log("no annotations");
		return;
	}
	for (const annotation of annotations) console.log(formatAnnotation(annotation));
}

export async function runWorkspaceAnnotationRefresh(workspaceId: string | undefined, id: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !id) fail(USAGE);
	const { subtype, title, body, anchors } = requireAnnotationFields(flags);
	const client = await connectLectorClient();
	const { annotation } = await client.call("workspace.refreshAnnotation", { workspaceId, id, subtype, title, body, anchors });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(annotation ?? null));
		return;
	}
	console.log(annotation ? formatAnnotation(annotation) : `no annotation "${id}" in workspace "${workspaceId}"`);
}

export async function runWorkspaceAnnotationScrub(workspaceId: string | undefined, id: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !id) fail(USAGE);
	const client = await connectLectorClient();
	const { scrubbed } = await client.call("workspace.scrubAnnotation", { workspaceId, id });
	console.log(hasFlag(flags, "--json") ? JSON.stringify({ scrubbed }) : scrubbed ? `scrubbed ${id}` : `"${id}" was already scrubbed or does not exist`);
}

export async function runWorkspaceAnnotationRestore(workspaceId: string | undefined, id: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !id) fail(USAGE);
	const client = await connectLectorClient();
	const { restored } = await client.call("workspace.restoreAnnotation", { workspaceId, id });
	console.log(hasFlag(flags, "--json") ? JSON.stringify({ restored }) : restored ? `restored "${id}"` : `"${id}" was not scrubbed or does not exist`);
}

export async function runWorkspaceAnnotationContain(
	workspaceId: string | undefined,
	parentId: string | undefined,
	childId: string | undefined,
	flags: string[],
): Promise<void> {
	if (!workspaceId || !parentId || !childId) fail(USAGE);
	const client = await connectLectorClient();
	const { contained } = await client.call("workspace.containAnnotation", { workspaceId, parentId, childId });
	console.log(hasFlag(flags, "--json") ? JSON.stringify({ contained }) : `"${parentId}" now contains "${childId}"`);
}

export async function runWorkspaceAnnotationUncontain(
	workspaceId: string | undefined,
	parentId: string | undefined,
	childId: string | undefined,
	flags: string[],
): Promise<void> {
	if (!workspaceId || !parentId || !childId) fail(USAGE);
	const client = await connectLectorClient();
	const { uncontained } = await client.call("workspace.uncontainAnnotation", { workspaceId, parentId, childId });
	console.log(
		hasFlag(flags, "--json")
			? JSON.stringify({ uncontained })
			: uncontained
				? `"${parentId}" no longer contains "${childId}"`
				: `"${parentId}" did not contain "${childId}"`,
	);
}

export async function runWorkspaceAnnotationTree(workspaceId: string | undefined, rootId: string | undefined, flags: string[]): Promise<void> {
	if (!workspaceId || !rootId) fail(USAGE);
	const maxDepthFlagValue = flagValue(flags, "--max-depth");
	if (maxDepthFlagValue === undefined) fail(USAGE);
	const client = await connectLectorClient();
	const { annotations } = await client.call("workspace.annotationTree", { workspaceId, rootId, maxDepth: Number(maxDepthFlagValue) });
	if (hasFlag(flags, "--json")) {
		console.log(JSON.stringify(annotations));
		return;
	}
	if (annotations.length === 0) {
		console.log(`no annotation "${rootId}"`);
		return;
	}
	for (const annotation of annotations) console.log(formatAnnotation(annotation));
}

const WORKSPACE_ANNOTATION_ACTIONS: Record<string, (annWorkspaceId: string | undefined, annRest: string[]) => Promise<void>> = {
	create: (annWorkspaceId, annRest) => runWorkspaceAnnotationCreate(annWorkspaceId, annRest),
	list: runWorkspaceAnnotationList,
	contain: (annWorkspaceId, annRest) => {
		const [parentId, childId, ...containFlags] = annRest;
		return runWorkspaceAnnotationContain(annWorkspaceId, parentId, childId, containFlags);
	},
	uncontain: (annWorkspaceId, annRest) => {
		const [parentId, childId, ...containFlags] = annRest;
		return runWorkspaceAnnotationUncontain(annWorkspaceId, parentId, childId, containFlags);
	},
	get: (annWorkspaceId, annRest) => {
		const [annotationId, ...annFlags] = annRest;
		return runWorkspaceAnnotationGet(annWorkspaceId, annotationId, annFlags);
	},
	refresh: (annWorkspaceId, annRest) => {
		const [annotationId, ...annFlags] = annRest;
		return runWorkspaceAnnotationRefresh(annWorkspaceId, annotationId, annFlags);
	},
	scrub: (annWorkspaceId, annRest) => {
		const [annotationId, ...annFlags] = annRest;
		return runWorkspaceAnnotationScrub(annWorkspaceId, annotationId, annFlags);
	},
	restore: (annWorkspaceId, annRest) => {
		const [annotationId, ...annFlags] = annRest;
		return runWorkspaceAnnotationRestore(annWorkspaceId, annotationId, annFlags);
	},
	tree: (annWorkspaceId, annRest) => {
		const [annotationId, ...annFlags] = annRest;
		return runWorkspaceAnnotationTree(annWorkspaceId, annotationId, annFlags);
	},
};

export async function runWorkspaceAnnotation(actionArgs: string[]): Promise<void> {
	const [subcommand, annWorkspaceId, ...annRest] = actionArgs;
	const handler = subcommand ? WORKSPACE_ANNOTATION_ACTIONS[subcommand] : undefined;
	if (!handler) fail(USAGE);
	return handler(annWorkspaceId, annRest);
}
