import { jsonByteSize } from "../bounds/bound-list.ts";
import { resolveBound } from "./bounds.ts";
import type { DiagnosticValidationCoordinator, DiagnosticValidationResult, GitDiagnosticValidationResult } from "./diagnostic-validation-coordinator.ts";
import type { OperationInputs, OperationOutputs } from "./operations.ts";
import type { MutableRegistry } from "./workspace-registry.ts";

const DEFAULT_DELTA_RESULTS = 500;
const MAX_DELTA_RESULTS = 10_000;
const DEFAULT_DELTA_BYTES = 256 * 1024;
const MAX_DELTA_BYTES = 4 * 1024 * 1024;
const MAX_TRANSACTION_ID_BYTES = 4_096;

export class DiagnosticValidationNotFound extends Error {
	constructor(readonly transactionId: string) {
		super(`no diagnostic validation was recorded for mutation transaction ${transactionId}`);
		this.name = "DiagnosticValidationNotFound";
	}
}

function boundResult(
	result: DiagnosticValidationResult | GitDiagnosticValidationResult,
	maxResults: number,
	maxBytes: number,
): OperationOutputs["workspace.diagnosticDelta"] {
	const mutable = {
		...result,
		introduced: [...result.introduced].slice(0, maxResults),
		resolved: [...result.resolved].slice(0, maxResults),
		changed: [...result.changed].slice(0, maxResults),
		truncated: result.introduced.length > maxResults || result.resolved.length > maxResults || result.changed.length > maxResults,
	};
	const lists = [mutable.changed, mutable.resolved, mutable.introduced];
	while (jsonByteSize(mutable) > maxBytes) {
		const list = lists.find((candidate) => candidate.length > 0);
		if (!list) throw new TypeError(`maxBytes ${maxBytes} is too small for diagnostic-delta metadata`);
		list.pop();
		mutable.truncated = true;
	}
	return mutable;
}

export function createDiagnosticDeltaHandler(
	coordinator: DiagnosticValidationCoordinator,
	gitDelta: (input: OperationInputs["workspace.diagnosticDelta"] & { source: { kind: "git"; ref: string } }) => Promise<GitDiagnosticValidationResult>,
) {
	return async (_registry: MutableRegistry, input: OperationInputs["workspace.diagnosticDelta"]): Promise<OperationOutputs["workspace.diagnosticDelta"]> => {
		const sourceId = input.source.kind === "transaction" ? input.source.transactionId : input.source.ref;
		if (Buffer.byteLength(sourceId, "utf8") > MAX_TRANSACTION_ID_BYTES) {
			throw new TypeError(`diagnostic delta source id must be at most ${MAX_TRANSACTION_ID_BYTES} bytes`);
		}
		const maxResults = resolveBound(input.maxResults, DEFAULT_DELTA_RESULTS, MAX_DELTA_RESULTS, "maxResults");
		const maxBytes = resolveBound(input.maxBytes, DEFAULT_DELTA_BYTES, MAX_DELTA_BYTES, "maxBytes");
		const result = input.source.kind === "git" ? await gitDelta({ ...input, source: input.source }) : coordinator.result(input.source.transactionId);
		if (!result) throw new DiagnosticValidationNotFound(input.source.kind === "transaction" ? input.source.transactionId : input.source.ref);
		return boundResult(result, maxResults, maxBytes);
	};
}
