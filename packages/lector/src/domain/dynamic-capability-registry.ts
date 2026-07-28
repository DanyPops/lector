/**
 * Tracks the dynamic client-side state a warm LSP server can establish
 * mid-session via server-initiated requests: capability registrations
 * (most importantly workspace/didChangeWatchedFiles, the watched-file
 * patterns a future local watcher needs to honor) and progress tokens
 * created via window/workDoneProgress/create. Pure and subprocess-free,
 * so it is independently testable against arbitrary registration payloads.
 */

export class DynamicCapabilityCapacityExceeded extends Error {
	constructor(
		readonly kind: "registration" | "progress-token",
		readonly max: number,
	) {
		super(`dynamic ${kind} capacity exceeded (${max})`);
		this.name = "DynamicCapabilityCapacityExceeded";
	}
}

export interface FileSystemWatcherPattern {
	readonly globPattern: string;
	/** WatchKind bitmask (Create=1, Change=2, Delete=4). Defaults to 7 (all three) per spec when a server omits it. */
	readonly kind: number;
}

interface DynamicRegistration {
	readonly method: string;
	readonly registerOptions: unknown;
}

const DEFAULT_MAX_REGISTRATIONS = 256;
const DEFAULT_MAX_PROGRESS_TOKENS = 256;

export interface DynamicCapabilityRegistryOptions {
	readonly maxRegistrations?: number;
	readonly maxProgressTokens?: number;
}

export class DynamicCapabilityRegistry {
	private readonly registrations = new Map<string, DynamicRegistration>();
	private readonly progressTokens = new Set<string | number>();
	private readonly latestProgress = new Map<string | number, unknown>();
	private readonly maxRegistrations: number;
	private readonly maxProgressTokens: number;

	constructor(options: DynamicCapabilityRegistryOptions = {}) {
		this.maxRegistrations = options.maxRegistrations ?? DEFAULT_MAX_REGISTRATIONS;
		this.maxProgressTokens = options.maxProgressTokens ?? DEFAULT_MAX_PROGRESS_TOKENS;
	}

	register(id: string, method: string, registerOptions: unknown): void {
		if (!this.registrations.has(id) && this.registrations.size >= this.maxRegistrations) {
			throw new DynamicCapabilityCapacityExceeded("registration", this.maxRegistrations);
		}
		this.registrations.set(id, { method, registerOptions });
	}

	/** Idempotent: unregistering an id that was never registered (or already removed) is a no-op, not an error. */
	unregister(id: string): void {
		this.registrations.delete(id);
	}

	createProgressToken(token: string | number): void {
		if (!this.progressTokens.has(token) && this.progressTokens.size >= this.maxProgressTokens) {
			throw new DynamicCapabilityCapacityExceeded("progress-token", this.maxProgressTokens);
		}
		this.progressTokens.add(token);
	}

	/**
	 * Records a $/progress notification's latest value for `token`. A notification has no reply
	 * to withhold, so unlike register()/createProgressToken() this never throws on overflow --
	 * it silently drops the update, matching best-effort telemetry semantics rather than risking
	 * an uncaught exception inside the notification-dispatch path killing the whole connection.
	 */
	recordProgress(token: string | number, value: unknown): void {
		if (!this.latestProgress.has(token) && this.latestProgress.size >= this.maxProgressTokens) return;
		this.latestProgress.set(token, value);
	}

	/** The latest $/progress value seen for every token reported so far (bounded; oldest silently dropped once full). */
	get progressByToken(): ReadonlyMap<string | number, unknown> {
		return this.latestProgress;
	}

	get registrationCount(): number {
		return this.registrations.size;
	}

	get progressTokenCount(): number {
		return this.progressTokens.size;
	}

	/** Every glob pattern registered across all workspace/didChangeWatchedFiles registrations, for a local file watcher to honor. */
	get watchedFilePatterns(): readonly FileSystemWatcherPattern[] {
		const patterns: FileSystemWatcherPattern[] = [];
		for (const registration of this.registrations.values()) {
			if (registration.method !== "workspace/didChangeWatchedFiles") continue;
			patterns.push(...extractWatchers(registration.registerOptions));
		}
		return patterns;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function extractGlobPattern(value: unknown): string | undefined {
	if (typeof value === "string") return value;
	// RelativePattern shape ({ baseUri, pattern }); only the pattern portion is captured today.
	if (isRecord(value) && typeof value.pattern === "string") return value.pattern;
	return undefined;
}

function extractWatchers(registerOptions: unknown): FileSystemWatcherPattern[] {
	if (!isRecord(registerOptions) || !Array.isArray(registerOptions.watchers)) return [];
	const result: FileSystemWatcherPattern[] = [];
	for (const watcher of registerOptions.watchers) {
		if (!isRecord(watcher)) continue;
		const globPattern = extractGlobPattern(watcher.globPattern);
		if (globPattern === undefined) continue;
		const kind = typeof watcher.kind === "number" ? watcher.kind : 7;
		result.push({ globPattern, kind });
	}
	return result;
}

export interface ParsedRegistration {
	readonly id: string;
	readonly method: string;
	readonly registerOptions: unknown;
}

/** Parses client/registerCapability's params ({ registrations: Registration[] }); malformed/missing entries are skipped, never thrown. */
export function parseRegistrationRequest(params: unknown): ParsedRegistration[] {
	if (!isRecord(params) || !Array.isArray(params.registrations)) return [];
	const result: ParsedRegistration[] = [];
	for (const entry of params.registrations) {
		if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.method !== "string") continue;
		result.push({ id: entry.id, method: entry.method, registerOptions: entry.registerOptions });
	}
	return result;
}

/**
 * Parses client/unregisterCapability's params. The field is genuinely spelled
 * "unregisterations" in the LSP specification itself (UnregistrationParams) --
 * not a typo introduced here.
 */
export function parseUnregistrationRequest(params: unknown): string[] {
	if (!isRecord(params) || !Array.isArray(params.unregisterations)) return [];
	const result: string[] = [];
	for (const entry of params.unregisterations) {
		if (isRecord(entry) && typeof entry.id === "string") result.push(entry.id);
	}
	return result;
}

/** Parses workspace/configuration's params ({ items: ConfigurationItem[] }); the response must be an array of the same length. */
export function parseConfigurationItemCount(params: unknown): number {
	if (!isRecord(params) || !Array.isArray(params.items)) return 0;
	return params.items.length;
}

/** Parses window/workDoneProgress/create's params ({ token: ProgressToken }); ProgressToken is a number or string. */
export function parseProgressCreateToken(params: unknown): string | number | undefined {
	if (!isRecord(params)) return undefined;
	const token = params.token;
	return typeof token === "string" || typeof token === "number" ? token : undefined;
}

export interface ParsedProgressNotification {
	readonly token: string | number;
	readonly value: unknown;
}

/** Parses a $/progress notification's params ({ token: ProgressToken, value: unknown }); undefined if the token is missing or malformed. */
export function parseProgressNotification(params: unknown): ParsedProgressNotification | undefined {
	if (!isRecord(params)) return undefined;
	const token = params.token;
	if (typeof token !== "string" && typeof token !== "number") return undefined;
	return { token, value: params.value };
}
