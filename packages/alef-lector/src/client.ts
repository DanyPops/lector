// Deep import, bypassing @danypops/lector's own barrel (which also re-exports the daemon:
// service.ts, every adapter, LSP, tree-sitter, sqlite). This keeps what a bundler must pull
// in limited to what a client genuinely needs. Operation types are type-only (erased before
// bundling), so importing them from service.ts -- which does declare the daemon, but only as
// types here -- costs nothing at runtime.
import { connectLectorClient, type LectorClient, remoteErrorIs } from "@danypops/lector/src/client.ts";
import type { OperationInputs, OperationName, OperationOutputs } from "@danypops/lector/src/service.ts";

/**
 * Lazily connects to a running Lector daemon and caches the connection for the process
 * lifetime. Never auto-spawns the daemon: a clear "start it with `lector serve`" error
 * (thrown by connectLectorClient itself) is preferable to guessing at a lifecycle the
 * host didn't ask for.
 *
 * A failed call drops the cached client but does not itself retry: the daemon binds a
 * new random port on every restart, so a client resolved before a restart would
 * otherwise point at a dead port for the rest of the process's life -- but blindly
 * retrying the same call risks double-executing a mutation (workspace.exactEdit) behind
 * what looks like one failed attempt. Dropping the cache is enough to self-heal on the
 * *next* call; a caller that specifically wants same-call retry decides that itself.
 */
/** How the module resolves a live LectorClient -- swappable so tests can inject a fake. */
type ClientConnector = () => Promise<LectorClient>;
let connector: ClientConnector = () => connectLectorClient();
let cached: Promise<LectorClient> | undefined;

/** The cached connection, or a freshly resolved one on first use / after a drop. */
function connect(): Promise<LectorClient> {
	cached ??= connector().catch((error: unknown) => {
		cached = undefined;
		throw error;
	});
	return cached;
}

/** Calls one Lector operation against the cached (or freshly connected) daemon client. */
export async function callLector<Name extends OperationName>(operation: Name, input: OperationInputs[Name]): Promise<OperationOutputs[Name]> {
	const client = await connect();
	try {
		return await client.call(operation, input);
	} catch (error) {
		cached = undefined;
		throw error;
	}
}

/** True when `error` is the client-side rejection of a call whose Lector domain error was `name`. */
export { remoteErrorIs };

/** Replace how this module connects to Lector -- tests inject an isolated daemon's client. */
export function setLectorClientConnectorForTests(value: ClientConnector): void {
	cached = undefined;
	connector = value;
}

/** Restore the real connectLectorClient() connector after a test that overrode it. */
export function resetLectorClientForTests(): void {
	cached = undefined;
	connector = () => connectLectorClient();
}
