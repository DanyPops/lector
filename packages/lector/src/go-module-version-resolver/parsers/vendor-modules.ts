export interface ParsedVendorModule {
	readonly modulePath: string;
	readonly version: string;
	readonly locator: string;
}

const MODULE_HEADER = /^# (\S+) (\S+)$/;

/**
 * Parses `vendor/modules.txt`'s own module headers (`# <module-path> <version>`). Every other
 * line -- `## explicit; go <version>` metadata and the vendored package paths themselves -- names
 * no version information this resolver needs and is skipped.
 */
export function parseVendorModulesTxt(text: string): readonly ParsedVendorModule[] {
	const modules: ParsedVendorModule[] = [];
	for (const line of text.split("\n")) {
		const match = MODULE_HEADER.exec(line);
		if (!match) continue;
		const [, modulePath, version] = match;
		if (!modulePath || !version) continue;
		modules.push({ modulePath, version, locator: line });
	}
	return modules;
}
