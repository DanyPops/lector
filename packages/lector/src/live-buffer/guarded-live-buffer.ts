import { type ContentHash, contentHashOf } from "../content-identity/content-hash.ts";
import { LiveBuffer } from "./live-buffer.ts";

export interface LiveBufferIdentity {
	readonly workspaceId: string;
	readonly path: string;
}

export interface StaleBufferState {
	readonly expectedHash: ContentHash;
	readonly actualHash: ContentHash | null;
}

/** Lector-owned editor state for one hash-guarded workspace entry. */
export class GuardedLiveBuffer {
	readonly buffer: LiveBuffer;
	private savedText: string;
	private savedHash: ContentHash;
	private staleState: StaleBufferState | null = null;

	constructor(
		readonly identity: LiveBufferIdentity,
		content: string,
		observedHash: string,
	) {
		const computedHash = contentHashOf(content);
		if (computedHash !== observedHash) throw new Error(`Content/hash mismatch while opening "${identity.path}"`);
		this.buffer = new LiveBuffer(content);
		this.savedText = content;
		this.savedHash = computedHash;
	}

	get dirty(): boolean {
		return this.buffer.text !== this.savedText;
	}

	get expectedHash(): ContentHash {
		return this.savedHash;
	}

	get stale(): StaleBufferState | null {
		return this.staleState;
	}

	/** Advance the guard only after the exact content captured for save commits. */
	markSaved(content: string, newHash: string): void {
		const computedHash = contentHashOf(content);
		if (computedHash !== newHash) throw new Error(`Content/hash mismatch after saving "${this.identity.path}"`);
		this.savedText = content;
		this.savedHash = computedHash;
		this.staleState = null;
	}

	markStale(actualHash: string | null): void {
		this.staleState = { expectedHash: this.savedHash, actualHash: actualHash === null ? null : contentHashOfHash(actualHash) };
	}
}

function contentHashOfHash(value: string): ContentHash {
	if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("Lector returned an invalid content hash");
	// The value is structurally validated as the same SHA-256 representation minted by contentHashOf.
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
	return value as ContentHash;
}
