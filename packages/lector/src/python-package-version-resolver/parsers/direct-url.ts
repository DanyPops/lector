import type { PythonInstallKind } from "../installed-package-version.ts";
import type { PythonResolutionContext } from "../resolution-context.ts";
import { isRecord, stringField } from "./shared.ts";

export interface ParsedDirectUrl {
	readonly kind: PythonInstallKind;
	readonly directSource: string;
	readonly commit: string | null;
}

/**
 * Parses a real `direct_url.json` (PEP 610 -- installed alongside a dist-info directory whenever
 * pip installed a package from something other than a plain registry wheel/sdist lookup) into the
 * one real distinction that matters for source resolution: a VCS install carries its own exact
 * commit already, an editable local-path install has none, and a plain direct-URL install (e.g.
 * `pip install https://.../foo.whl`) is neither.
 */
export function parseDirectUrlJson(text: string, context: PythonResolutionContext): ParsedDirectUrl | null {
	const parsed = context.parseJson(text);
	if (!isRecord(parsed)) return null;
	const url = stringField(parsed, "url");
	if (url === null) return null;
	const vcsInfo = isRecord(parsed.vcs_info) ? parsed.vcs_info : null;
	if (vcsInfo !== null) {
		const commit = stringField(vcsInfo, "commit_id");
		return { kind: "direct-vcs", directSource: url, commit };
	}
	const dirInfo = isRecord(parsed.dir_info) ? parsed.dir_info : null;
	if (dirInfo !== null && dirInfo.editable === true) return { kind: "editable", directSource: url, commit: null };
	return { kind: "direct-url", directSource: url, commit: null };
}
