/**
 * Escapes a Go module path the same way GOPROXY's own protocol does before it appears in a
 * request URL: every uppercase letter becomes `!` followed by its lowercase form. Go module
 * paths are case-sensitive, but proxy storage and some registries are not -- this escaping keeps
 * two differently-cased paths from colliding on a case-insensitive filesystem or URL.
 */
export function escapeGoModulePath(modulePath: string): string {
	return modulePath.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);
}
