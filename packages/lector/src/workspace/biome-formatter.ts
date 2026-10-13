import { execFile } from "node:child_process";
import { dirname, extname, isAbsolute } from "node:path";
import type { ContentFormatter } from "./mutation-plan.ts";

const extensions = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".json", ".jsonc", ".css", ".graphql", ".gql"]);

export function biomeFormatter(executable: string): ContentFormatter {
	if (!isAbsolute(executable)) throw new Error("The Biome formatter executable must be an explicit absolute path");
	return async (path, content) => {
		if (!extensions.has(extname(path))) throw new Error(`Biome preview formatting is not configured for ${extname(path) || "extensionless files"}`);
		if (Buffer.byteLength(content) > 1_048_576) throw new Error("Formatter input exceeds one MiB");
		return new Promise<string>((resolve, reject) => {
			const child = execFile(
				executable,
				["format", `--stdin-file-path=${path}`],
				{ cwd: dirname(path), encoding: "utf8", timeout: 15_000, maxBuffer: 1_048_576 },
				(error, stdout) => {
					if (error) reject(new Error("Biome preview formatting failed", { cause: error }));
					else resolve(stdout);
				},
			);
			child.stdin?.on("error", reject);
			child.stdin?.end(content);
		});
	};
}
