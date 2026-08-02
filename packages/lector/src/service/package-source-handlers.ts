import { stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { LocalFilesystemWorkspace } from "../adapters/local-filesystem-workspace.ts";
import { ReadOnlyWorkspace } from "../adapters/read-only-workspace.ts";
import { PACKAGE_ECOSYSTEMS } from "../domain/package-source.ts";
import { type PackageSourceListEntry, queryPackageSourceIndex } from "../domain/package-source-index.ts";
import { InvalidPackageSourceContract, resolvePackageSource } from "../domain/resolve-package-source.ts";
import type { PackageSourceIndexPort } from "../ports/package-source-index-port.ts";
import type { PackageSourceResolverPort } from "../ports/package-source-resolver-port.ts";
import type { RepoFetcherPort } from "../ports/repo-fetcher-port.ts";
import {
	deriveWorkspaceId,
	InvalidWorkspaceRoot,
	type MutableRegistry,
	type OperationInputs,
	type OperationOutputs,
	PackageSourceEntryInUse,
	PackageSourceResolverNotConfigured,
} from "../service.ts";

export interface PackageSourceHandlerDeps {
	readonly packageSourceResolver: PackageSourceResolverPort | undefined;
	readonly packageSourceIndex: PackageSourceIndexPort;
	readonly repoFetcher: RepoFetcherPort | undefined;
}

export interface PackageSourceHandlers {
	"package.resolveSource": (registry: MutableRegistry, input: OperationInputs["package.resolveSource"]) => Promise<OperationOutputs["package.resolveSource"]>;
	"package.listSources": (registry: MutableRegistry, input: OperationInputs["package.listSources"]) => Promise<OperationOutputs["package.listSources"]>;
	"package.removeSource": (registry: MutableRegistry, input: OperationInputs["package.removeSource"]) => Promise<OperationOutputs["package.removeSource"]>;
	"package.cleanSources": (registry: MutableRegistry, input: OperationInputs["package.cleanSources"]) => Promise<OperationOutputs["package.cleanSources"]>;
}

/** package.resolveSource/listSources/removeSource/cleanSources -- resolving an installed package's exact upstream source and bookkeeping it in PackageSourceIndexPort, distinct from RepoFetcherPort's own disk cache. */
export function createPackageSourceHandlers(deps: PackageSourceHandlerDeps): PackageSourceHandlers {
	return {
		async "package.resolveSource"(registry, input) {
			if (!deps.packageSourceResolver) throw new PackageSourceResolverNotConfigured();
			const outcome = await resolvePackageSource(deps.packageSourceResolver, input.request, input.bounds);
			if (outcome.status !== "verified") return { outcome, workspaceId: null };
			const absolutePath = resolve(outcome.workspace.cachePath);
			let sourceStats: Awaited<ReturnType<typeof stat>>;
			try {
				sourceStats = await stat(absolutePath);
			} catch {
				throw new InvalidWorkspaceRoot(absolutePath, "verified package source does not exist or is not accessible");
			}
			if (!sourceStats.isDirectory()) throw new InvalidWorkspaceRoot(absolutePath, "verified package source is not a directory");
			const workspaceId = deriveWorkspaceId(absolutePath);
			if (!registry.has(workspaceId)) {
				registry.set(workspaceId, { port: new ReadOnlyWorkspace(new LocalFilesystemWorkspace(absolutePath)), rootPath: absolutePath, origin: "remote" });
			}
			await deps.packageSourceIndex.record({
				ecosystem: outcome.coordinate.ecosystem,
				registry: outcome.coordinate.registry,
				name: outcome.coordinate.name,
				resolvedVersion: outcome.coordinate.resolvedVersion,
				requestedVersion: outcome.coordinate.requestedVersion,
				repositoryUrl: outcome.repository.url,
				resolvedRef: outcome.repository.resolvedRef,
				commit: outcome.repository.commit,
				cachePath: absolutePath,
				workspaceId,
				origin: outcome.workspace.origin,
				verificationMethod: outcome.verification.method,
				resolvedAt: Date.now(),
			});
			return { outcome, workspaceId };
		},
		async "package.listSources"(_registry, input) {
			if (!deps.packageSourceResolver) throw new PackageSourceResolverNotConfigured();
			if (input.ecosystem !== undefined && !PACKAGE_ECOSYSTEMS.includes(input.ecosystem)) throw new InvalidPackageSourceContract("ecosystem");
			const allEntries = await deps.packageSourceIndex.list();
			const cached = deps.repoFetcher ? await deps.repoFetcher.listCached() : [];
			const page = queryPackageSourceIndex(allEntries, { ecosystem: input.ecosystem, text: input.text }, input.maxResults, input.cursor);
			const entries: PackageSourceListEntry[] = page.entries.map((entry) => {
				const match = cached.find((candidate) => entry.cachePath === candidate.path || entry.cachePath.startsWith(`${candidate.path}${sep}`));
				return { ...entry, cacheSizeBytes: match?.cacheSizeBytes ?? null };
			});
			return { entries, nextCursor: page.nextCursor };
		},
		/** Refuses (PackageSourceEntryInUse) rather than dropping the bookkeeping for a currently-registered workspace's backing checkout out from under it -- there is no workspace.unregister operation, mirroring repo.evictCache's identical refusal. Removes only the package-source index entry (bookkeeping); the underlying RepoFetcherPort disk cache entry is a separate, independently-addressed cache managed by repo.evictCache/repo_cache, not duplicated here -- a monorepo can have several package-source entries sharing one physical checkout, so this handler must never assume ownership of it. */
		async "package.removeSource"(registry, input) {
			if (!deps.packageSourceResolver) throw new PackageSourceResolverNotConfigured();
			if (!PACKAGE_ECOSYSTEMS.includes(input.ecosystem)) throw new InvalidPackageSourceContract("ecosystem");
			const existing = (await deps.packageSourceIndex.list()).find(
				(entry) =>
					entry.ecosystem === input.ecosystem &&
					entry.registry === input.registry &&
					entry.name === input.name &&
					entry.resolvedVersion === input.resolvedVersion,
			);
			if (existing && registry.has(existing.workspaceId)) throw new PackageSourceEntryInUse(existing.workspaceId);
			const removed = await deps.packageSourceIndex.remove(input);
			return { removed };
		},
		async "package.cleanSources"(registry, input) {
			if (!deps.packageSourceResolver) throw new PackageSourceResolverNotConfigured();
			if (input.ecosystem !== undefined && !PACKAGE_ECOSYSTEMS.includes(input.ecosystem)) throw new InvalidPackageSourceContract("ecosystem");
			const allEntries = await deps.packageSourceIndex.list();
			const matching = input.ecosystem === undefined ? allEntries : allEntries.filter((entry) => entry.ecosystem === input.ecosystem);
			let removed = 0;
			let skipped = 0;
			for (const entry of matching) {
				if (registry.has(entry.workspaceId)) {
					skipped++;
					continue;
				}
				await deps.packageSourceIndex.remove(entry);
				removed++;
			}
			return { removed, skipped };
		},
	};
}
