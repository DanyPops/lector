/**
 * Shared test wiring for any operation dispatched through invokeLectorVehicleOperation (see
 * ../../extension/src/vehicle-client.ts): starts an isolated Lector daemon, points BOTH the
 * legacy LectorClient connector and the new vehicle client connector at it (Phase 1 mounts
 * /vehicle/* on the exact same port/token as /api/v1/ops), and builds a real ExtensionContext
 * via @danypops/pi-extension-harness for invokeVehicleOperation's own context param.
 */
import { createExtensionHarness } from "@danypops/pi-extension-harness";
import { RemoteVehicleClient } from "@danypops/vehicle-client/http";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setLectorClientConnectorForTests } from "../../extension/src/lector-client.ts";
import { setLectorVehicleClientConnectorForTests } from "../../extension/src/vehicle-client.ts";
import { startIsolatedLectorDaemon } from "./isolated-lector-daemon.ts";

let nextToolCallId = 0;

export async function wireVehicleDaemon(
	options: Parameters<typeof startIsolatedLectorDaemon>[0] = {},
	cwd: string = process.cwd(),
): Promise<{ stop: () => Promise<void>; call: (toolName: string) => Promise<{ toolName: string; toolCallId: string; context: ExtensionContext }> }> {
	const daemon = await startIsolatedLectorDaemon(options);
	setLectorClientConnectorForTests(() => Promise.resolve(daemon.client));
	setLectorVehicleClientConnectorForTests(() => Promise.resolve(new RemoteVehicleClient({ baseUrl: daemon.baseUrl, token: daemon.token })));

	return {
		stop: daemon.stop,
		call: async (toolName: string) => {
			const h = createExtensionHarness(async () => {}, { cwd });
			await h.boot();
			return { toolName, toolCallId: `t${++nextToolCallId}`, context: h.ctx };
		},
	};
}
