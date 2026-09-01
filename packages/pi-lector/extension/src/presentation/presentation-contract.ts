import type { JsonValue } from "@danypops/vehicle-core";
import type { AgentToolResult, AgentToolUpdateCallback, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { boundModelContentText, DEFAULT_MODEL_CONTENT_BYTES } from "./model-content.ts";
import { type PresentationFamily, presentationFamily } from "./tool-presentation.ts";

export const LECTOR_PRESENTATION_SCHEMA = "pi-lector.presentation/v1";
export const DEFAULT_LECTOR_PRESENTATION_MAX_BYTES = 128 * 1024;

interface LectorPresentationBase {
	readonly schema: typeof LECTOR_PRESENTATION_SCHEMA;
	readonly tool: string;
	readonly action: string | null;
	readonly payload: JsonValue;
}

/** Versioned presentation variants persisted independently from model-facing content. */
export type LectorToolPresentation = {
	readonly [Family in PresentationFamily]: LectorPresentationBase & { readonly family: Family };
}[PresentationFamily];

export type LectorPresentationEnvelope = LectorToolPresentation;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (isRecord(value)) return Object.values(value).every(isJsonValue);
	return false;
}

function serializedJsonValue(value: unknown): JsonValue {
	if (value === undefined) return null;
	let serialized: string;
	try {
		serialized = JSON.stringify(value, (_key, candidate: unknown) => {
			if (typeof candidate === "number" && !Number.isFinite(candidate)) throw new TypeError("non-finite number");
			if (typeof candidate === "bigint" || typeof candidate === "function" || typeof candidate === "symbol") {
				throw new TypeError(`unsupported ${typeof candidate}`);
			}
			return candidate;
		});
	} catch (error) {
		throw new TypeError(`presentation details must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`);
	}
	const parsed: unknown = JSON.parse(serialized);
	if (!isJsonValue(parsed)) throw new TypeError("presentation details must contain only JSON values");
	return parsed;
}

/** Projects one tool's renderer details into the versioned, serializable session boundary. */
export function projectLectorPresentation(
	tool: string,
	details: unknown,
	maxBytes = DEFAULT_LECTOR_PRESENTATION_MAX_BYTES,
	actionOverride?: string,
): LectorPresentationEnvelope {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("presentation maxBytes must be a positive integer");
	const action = actionOverride ?? (isRecord(details) && typeof details.action === "string" ? details.action : null);
	const envelope: LectorPresentationEnvelope = {
		schema: LECTOR_PRESENTATION_SCHEMA,
		tool,
		action,
		family: presentationFamily(tool, action ?? undefined),
		payload: serializedJsonValue(details),
	};
	const bytes = Buffer.byteLength(JSON.stringify(envelope), "utf8");
	if (bytes > maxBytes) throw new RangeError(`presentation details exceed ${maxBytes} bytes (${bytes} observed)`);
	return envelope;
}

/** Validates the shared envelope. Domain renderers retain responsibility for validating their payload variant. */
export function parseLectorPresentation(details: unknown, expectedTool: string): JsonValue | undefined {
	if (!isRecord(details)) return undefined;
	if (details.schema !== LECTOR_PRESENTATION_SCHEMA || details.tool !== expectedTool || !("payload" in details)) return undefined;
	if (details.action !== null && typeof details.action !== "string") return undefined;
	if (details.family !== presentationFamily(expectedTool, typeof details.action === "string" ? details.action : undefined)) return undefined;
	try {
		return serializedJsonValue(details.payload);
	} catch {
		return undefined;
	}
}

function fallbackText(result: AgentToolResult<unknown>, theme: Theme): Text {
	const content = result.content
		.filter((block): block is Extract<(typeof result.content)[number], { type: "text" }> => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return new Text(theme.fg("toolOutput", content || "No result."), 0, 0);
}

export interface LectorPresentationOptions {
	readonly maxBytes?: number;
	readonly maxModelContentBytes?: number;
}

/** Wraps a production tool so persisted renderer details cross one validated, bounded envelope. */
export function withLectorPresentation<TParams extends TSchema, TDetails, TState>(
	tool: ToolDefinition<TParams, TDetails, TState>,
	options: LectorPresentationOptions = {},
): ToolDefinition<TParams, LectorPresentationEnvelope, TState> {
	const maxBytes = options.maxBytes ?? DEFAULT_LECTOR_PRESENTATION_MAX_BYTES;
	const maxModelContentBytes = options.maxModelContentBytes ?? DEFAULT_MODEL_CONTENT_BYTES;
	return {
		...tool,
		async execute(toolCallId, params, signal, onUpdate, context) {
			const parameterRecord = params as Record<string, unknown>;
			const action =
				typeof parameterRecord.action === "string"
					? parameterRecord.action
					: typeof parameterRecord.direction === "string"
						? parameterRecord.direction
						: undefined;
			const boundedContent = (content: AgentToolResult<unknown>["content"]): AgentToolResult<unknown>["content"] =>
				content.map((block) => (block.type === "text" ? { ...block, text: boundModelContentText(block.text, maxModelContentBytes) } : block));
			const wrappedUpdate: AgentToolUpdateCallback<TDetails> | undefined = onUpdate
				? (update) =>
						onUpdate({
							...update,
							content: boundedContent(update.content),
							details: projectLectorPresentation(tool.name, update.details, maxBytes, action),
						})
				: undefined;
			const result = await tool.execute(toolCallId, params, signal, wrappedUpdate, context);
			return {
				...result,
				content: boundedContent(result.content),
				details: projectLectorPresentation(tool.name, result.details, maxBytes, action),
			};
		},
		renderResult(result, renderOptions, theme, context) {
			const payload = parseLectorPresentation(result.details, tool.name);
			if (payload === undefined && !renderOptions.isPartial && !context.isError) return fallbackText(result, theme);
			if (!tool.renderResult) return fallbackText(result, theme);
			// The envelope is the runtime validation boundary. Each existing domain renderer narrows
			// its own payload variant; this is the single shared assertion that reconnects its generic.
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
			const domainDetails = payload as TDetails;
			return tool.renderResult({ ...result, details: domainDetails }, renderOptions, theme, context);
		},
	};
}
