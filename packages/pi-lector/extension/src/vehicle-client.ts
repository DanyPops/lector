/**
 * A real VehicleClient bridge to the Lector daemon's /vehicle/* HTTP surface (see Lector's own
 * daemon.ts, which mounts @danypops/vehicle-server/http's createVehicleHttpApp additively
 * alongside the legacy /api/v1/ops endpoint). Used by whichever pi-lector tool actions have
 * migrated onto Vehicle's operation-descriptor style so far (git status/log/diff today -- see
 * git/operations.ts) -- distinct from lector-client.ts's own LectorClient/OperationName
 * dispatch, which every other tool action still uses and will keep using until its own backing
 * operation migrates too.
 *
 * Same pattern already proven for web-spider's web_category (pi-web-spider's
 * invokeWebSpiderVehicleOperation) -- see also @danypops/vehicle-client-pi's own
 * invokeVehicleOperation() doc comment: a consumer whose tool deliberately consolidates several
 * operations behind one action parameter (Anthropic's own tool-design guidance) gets the same
 * cross-cutting policy layer (activity broadcasting, the local /safety ask gate, the server
 * approval-required retry dance, idempotency-key/correlationId derivation) a
 * registerVehicleTools()-registered tool gets automatically, without regressing its own
 * consolidated shape into one Pi tool per operation.
 *
 * Deliberately does NOT auto-spawn the daemon, matching lector-client.ts's own stated
 * convention: a clear "start it with `lector serve`" error beats guessing at a lifecycle the
 * user didn't ask for.
 */
import { resolveLectorDaemonConnection } from "@danypops/lector";
import { createReconnectingVehicleClient, daemonInstanceIdentity } from "@danypops/vehicle-client/daemon-client";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import { invokeVehicleOperation } from "@danypops/vehicle-client-pi";
import type { VehicleClient } from "@danypops/vehicle-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type VehicleClientConnector = () => Promise<VehicleClient>;

async function connectLectorVehicleClient(): Promise<VehicleClient> {
	const { host, port, token } = resolveLectorDaemonConnection();
	const client = new RemoteVehicleClient({ baseUrl: `http://${host}:${port}`, token });
	await client.negotiate({ minimumVersion: 1, maximumVersion: 1, requiredCapabilities: [], optionalCapabilities: [] });
	return client;
}

function resolveLectorVehicleIdentity() {
	try {
		const { host, port } = resolveLectorDaemonConnection();
		return daemonInstanceIdentity(`http://${host}:${port}`);
	} catch {
		return daemonInstanceIdentity("unresolved");
	}
}

let connector: VehicleClientConnector = connectLectorVehicleClient;
let vehicleClient: VehicleClient = createReconnectingVehicleClient(() => connector(), {
	resolveIdentity: resolveLectorVehicleIdentity,
	// connectRetry:true (vehicle-client's own bounded background retry budget) covers a daemon
	// that crashed and is mid systemd-restart -- without it, the very first call during that
	// window fails immediately instead of waiting the restart out, same policy as
	// lector-client.ts's own createRetryingLectorClient.
	connectRetry: true,
});

export function setLectorVehicleClientConnectorForTests(value: VehicleClientConnector): void {
	connector = value;
	vehicleClient = createReconnectingVehicleClient(() => connector());
}

export function resetLectorVehicleClientForTests(): void {
	connector = connectLectorVehicleClient;
	vehicleClient = createReconnectingVehicleClient(() => connector(), { resolveIdentity: resolveLectorVehicleIdentity, connectRetry: true });
}

/**
 * Everything about a real Pi tool call needed to invoke a Vehicle operation through it, except
 * which permissions this call declares -- that's operation-specific (matches whichever
 * *_PERMISSIONS constant the backing operation's own registration declared server-side), so it's
 * a separate invokeLectorVehicleOperation() argument, not part of this reusable per-tool-call
 * envelope.
 *
 * Deliberately has no `onUpdate` field: invokeVehicleOperation()'s own progress callback is typed
 * against PiVehicleToolDetails (vehicle-client-pi's generic {vehicle, progress}/{vehicle,
 * presentation} shape), never a specific tool's own XToolDetails -- none of git/
 * symbol_annotations/repo_cache/external_search/mutation_history's operations are long-running
 * enough to emit real mid-flight progress in practice, and forwarding a caller's own
 * differently-shaped onUpdate here would need an unsafe cast to paper over a real type mismatch,
 * not just a lint complaint.
 */
export interface LectorVehicleCall {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly signal?: AbortSignal;
	readonly context: ExtensionContext;
}

/**
 * Dispatches one already-VehicleRegistry-backed Lector operation through vehicle-client-pi's
 * cross-cutting policy layer instead of a bare lectorClient().call(), which would forfeit all of
 * it. Fetches the manifest on every call rather than caching it: these are low-frequency,
 * user-driven tool actions (not a hot loop), and a fresh manifest fetch is one cheap extra round
 * trip that also self-heals if the daemon's own operation set ever changes between calls.
 *
 * Generic over T (the caller's own known output shape for this specific operation) so every call
 * site gets a properly typed result without its own unsafe cast -- the one unavoidable narrowing
 * (result.details.output is typed unknown; see PiVehicleToolDetails) happens exactly once, here,
 * trusted because the caller already knows which operation it invoked and what shape that
 * operation's own registered output schema produces -- same trust boundary Lector's own
 * dispatch-through-registry.ts documents for its identical generic-unwrap seam.
 */
export async function invokeLectorVehicleOperation<T>(
	operationName: string,
	input: Record<string, unknown>,
	permissions: readonly string[],
	call: LectorVehicleCall,
): Promise<T> {
	const manifest = await vehicleClient.manifest();
	const descriptor = manifest.operations.find((op) => op.name === operationName);
	if (!descriptor) throw new Error(`Lector Vehicle manifest has no operation named '${operationName}'`);
	const result = await invokeVehicleOperation({
		client: vehicleClient,
		manifest,
		descriptor,
		toolName: call.toolName,
		toolCallId: call.toolCallId,
		input,
		context: call.context,
		signal: call.signal,
		options: { permissions },
	});
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- see this function's own doc comment.
	return result.details.output as T;
}
