import type { Logger } from "@danypops/vehicle-server/logging";

export interface RecordedLog {
	readonly level: "debug" | "info" | "warn" | "error";
	readonly message: string;
	readonly fields: Record<string, unknown> | undefined;
}

export function recordingLogger(): { readonly logger: Logger; readonly calls: RecordedLog[] } {
	const calls: RecordedLog[] = [];
	return {
		calls,
		logger: {
			debug: (message, fields) => calls.push({ level: "debug", message, fields }),
			info: (message, fields) => calls.push({ level: "info", message, fields }),
			warn: (message, fields) => calls.push({ level: "warn", message, fields }),
			error: (message, fields) => calls.push({ level: "error", message, fields }),
		},
	};
}
