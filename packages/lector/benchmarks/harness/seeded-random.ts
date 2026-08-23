/**
 * mulberry32 -- a small, fast, deterministic PRNG. Used to make a benchmark's own randomized
 * choices (e.g. which corpus subset to sample, or how to order interleaved control/candidate
 * rounds) reproducible from a recorded seed, distinct from Math.random's unrecorded state.
 */
export function createSeededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
