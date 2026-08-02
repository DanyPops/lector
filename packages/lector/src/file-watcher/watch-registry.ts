const MAX_WATCHES_PER_WORKSPACE = 32;

export interface WatchRegistration {
	readonly watchId: string;
	readonly workspaceId: string;
	readonly pattern: string;
	readonly topic: string;
}

/** Raised when a workspace already has MAX_WATCHES_PER_WORKSPACE registrations -- fails closed, the same bounded-resource discipline every other Lector capability already applies (maxOpenFiles, maxTopicsPerConnection, ...), rather than letting one workspace accumulate unbounded watch state. */
export class WatchLimitExceeded extends Error {
	constructor(
		readonly workspaceId: string,
		readonly max: number,
	) {
		super(`workspace "${workspaceId}" already has ${max} active watches -- unwatch one before adding another`);
		this.name = "WatchLimitExceeded";
	}
}

/**
 * Pure, in-memory bookkeeping of which patterns are being watched for which workspace, and
 * under which topic each one publishes -- no filesystem or network I/O here at all, kept
 * behind a port at the service layer (real OS watching, real PushChannel publishing) so this
 * class is fully testable on its own. Deliberately picomatch-agnostic: pattern MATCHING against
 * a real changed path is the service layer's own job, not this registry's.
 */
export class WatchRegistry {
	private readonly byId = new Map<string, WatchRegistration>();
	private readonly byWorkspace = new Map<string, Set<string>>();

	add(workspaceId: string, pattern: string, watchId: string, topic: string): WatchRegistration {
		const existing = this.byWorkspace.get(workspaceId) ?? new Set();
		if (existing.size >= MAX_WATCHES_PER_WORKSPACE) throw new WatchLimitExceeded(workspaceId, MAX_WATCHES_PER_WORKSPACE);
		const registration: WatchRegistration = { watchId, workspaceId, pattern, topic };
		existing.add(watchId);
		this.byWorkspace.set(workspaceId, existing);
		this.byId.set(watchId, registration);
		return registration;
	}

	/** The removed registration, or undefined if watchId was already unknown -- idempotent, like the rest of Lector's own unregister-shaped operations. Returns the registration itself (not just a boolean) so a caller can tell which workspace lost its last watch without a separate lookup. */
	remove(watchId: string): WatchRegistration | undefined {
		const registration = this.byId.get(watchId);
		if (!registration) return undefined;
		this.byId.delete(watchId);
		const workspaceWatches = this.byWorkspace.get(registration.workspaceId);
		workspaceWatches?.delete(watchId);
		if (workspaceWatches?.size === 0) this.byWorkspace.delete(registration.workspaceId);
		return registration;
	}

	/** False once a workspace has zero remaining registrations -- the service layer's own signal to close that workspace's underlying OS watcher. */
	hasAnyFor(workspaceId: string): boolean {
		return (this.byWorkspace.get(workspaceId)?.size ?? 0) > 0;
	}

	registrationsFor(workspaceId: string): readonly WatchRegistration[] {
		const ids = this.byWorkspace.get(workspaceId);
		if (!ids) return [];
		return Array.from(ids, (id) => this.byId.get(id)).filter((registration): registration is WatchRegistration => registration !== undefined);
	}
}
