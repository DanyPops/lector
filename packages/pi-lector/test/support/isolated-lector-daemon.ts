import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	connectLectorClientAt,
	type GithubSearchPort,
	InMemoryWorkspace,
	type LectorClient,
	type NpmRegistryPort,
	type PackageSourceResolverPort,
	type RepoFetcherPort,
	resolveLectorPaths,
	type SourcegraphSearchPort,
	startLectorDaemon,
} from "@danypops/lector";

/**
 * Boots a real, isolated Lector daemon (own XDG root, own port) for
 * pi-lector's tests -- the same "test through the real seams" approach
 * Lector's own test suite uses, not a mocked client. Uses
 * connectLectorClientAt() rather than constructing AuthenticatedRpcClient
 * directly, so pi-lector never needs its own @danypops/vehicle-server
 * dependency (and the version-skew/structural-type-mismatch risk that
 * would come with a second, independently-resolved copy of it).
 */
export async function startIsolatedLectorDaemon(
	options: {
		createRepoFetcher?: () => RepoFetcherPort;
		createPackageSourceResolver?: () => PackageSourceResolverPort;
		createNpmRegistry?: () => NpmRegistryPort;
		createGithubSearch?: () => GithubSearchPort;
		createSourcegraphSearch?: () => SourcegraphSearchPort;
	} = {},
): Promise<{
	client: LectorClient;
	baseUrl: string;
	token: string;
	/** The exact XDG env overrides this daemon was started with -- pass these to a real spawned `pi` child process (e.g. via pi-process-harness) so its own connectLectorClient() resolves to this same isolated daemon, not a stray real one. */
	env: Record<string, string>;
	stop: () => Promise<void>;
}> {
	const root = mkdtempSync(join(tmpdir(), "pi-lector-test-"));
	const env = { XDG_DATA_HOME: root, XDG_STATE_HOME: root, XDG_RUNTIME_DIR: root, XDG_CONFIG_HOME: root };
	const paths = resolveLectorPaths({ env });
	const daemon = await startLectorDaemon({
		workspaces: new Map([["bootstrap", new InMemoryWorkspace()]]),
		paths,
		createRepoFetcher: options.createRepoFetcher,
		createPackageSourceResolver: options.createPackageSourceResolver,
		createNpmRegistry: options.createNpmRegistry,
		createGithubSearch: options.createGithubSearch,
		createSourcegraphSearch: options.createSourcegraphSearch,
	});
	const token = readFileSync(paths.token, "utf8").trim();
	const baseUrl = `http://${daemon.host}:${daemon.port}`;
	const client = connectLectorClientAt(baseUrl, token);

	return {
		client,
		baseUrl,
		token,
		env,
		stop: async () => {
			await daemon.stop();
			rmSync(root, { recursive: true, force: true });
		},
	};
}
