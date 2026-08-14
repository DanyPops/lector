/**
 * Deliberately narrower than the root barrel: only LiveBuffer/BufferPosition are exposed here.
 * GuardedLiveBuffer and highlightSpans are Lector-domain-coupled (not generically reusable across
 * Pipes/Tickets/Web-Spider/Papyrus TUIs the way LiveBuffer itself is) -- still available via the
 * root "." export for Lector's own internal use, just not presented as a reusable building block
 * through this subpath. See the cross-cutting building-block survey finding (doc e740b2d1).
 */
export { type BufferPosition, LiveBuffer } from "./live-buffer.ts";
