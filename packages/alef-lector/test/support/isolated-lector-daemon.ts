import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectLectorClientAt,
	InMemoryWorkspace,
	type LectorClient,
	type PackageSourceResolverPort,
	type RepoFetcherPort,
	resolveLectorPaths,
	startLectorDaemon,
} from "@danypops/lector";

/**
 * Boots a real, isolated Lector daemon (own XDG root, own port) for
 * pi-lector's tests -- the same "test through the real seams" approach
 * Lector's own test suite uses, not a mocked client. Uses
 * connectLectorClientAt() rather than constructing AuthenticatedRpcClient
 * directly, so pi-lector never needs its own @danypops/daemon-kit
 * dependency (and the version-skew/structural-type-mismatch risk that
 * would come with a second, independently-resolved copy of it).
 */
export async function startIsolatedLectorDaemon(
	options: { createRepoFetcher?: () => RepoFetcherPort; createPackageSourceResolver?: () => PackageSourceResolverPort } = {},
): Promise<{ client: LectorClient; stop: () => Promise<void> }> {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-test-"));
	const paths = resolveLectorPaths({
		env: { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root },
	});
	const daemon = await startLectorDaemon({
		workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
		paths,
		createRepoFetcher: options.createRepoFetcher,
		createPackageSourceResolver: options.createPackageSourceResolver,
	});
	const token = readFileSync(paths.token, "utf8").trim();
	const client = connectLectorClientAt(`http://${daemon.host}:${daemon.port}`, token);

	return {
		client,
		stop: async () => {
			await daemon.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
