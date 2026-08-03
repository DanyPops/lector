/**
 * A minimal, real, local npm-registry-protocol server for testing the npm provisioning
 * installer against a genuine `npm install`, per this codebase's own "real mechanics, zero live
 * network" test convention (see GitRepoFetcher's own local-repo-standing-in-for-remote test).
 * Serves both endpoints a real install touches: the full packument (`GET /<name>`, what `npm
 * install` itself fetches) and the abbreviated single-version doc (`GET /<name>/<version-or-tag>`,
 * what Lector's own NpmRegistryClient.fetchVersion uses for resolution) -- plus the tarball
 * bytes themselves, built with the real `tar` binary so the archive's own bytes are genuine, not
 * a hand-rolled approximation of the format.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

export interface NpmRegistryFixtureOptions {
	readonly packageName: string;
	readonly version: string;
	readonly binName: string;
	/** The bin script's own real content (a shebang script -- npm makes the resulting node_modules/.bin/<binName> symlink executable itself, independent of this file's own mode bit). */
	readonly binScriptContent: string;
	readonly dependencies?: Record<string, string>;
	/** Test observability: called once per real tarball download this fixture serves -- a race-safety test can assert this stayed at 1 across several concurrent callers. */
	onTarballDownload?: () => void;
}

export interface NpmRegistryFixture {
	readonly url: string;
	readonly tarballDownloadCount: () => number;
	/** GET /<name>/<version-or-tag> -- Lector's own NpmRegistryClient.fetchVersion endpoint, exclusively; a real `npm install` subprocess never calls it, so this count is exactly "how many times did our own resolveNpmInstall() run", unaffected by npm's own local tarball cache. */
	readonly versionLookupCount: () => number;
	stop(): void;
}

function buildTarball(options: NpmRegistryFixtureOptions): { bytes: Buffer } {
	const workDir = mkdtempSync(join(tmpdir(), "lector-npm-fixture-pkg-"));
	try {
		const packageDir = join(workDir, "package");
		mkdirSync(join(packageDir, "bin"), { recursive: true });
		writeFileSync(
			join(packageDir, "package.json"),
			JSON.stringify(
				{
					name: options.packageName,
					version: options.version,
					bin: { [options.binName]: `bin/${options.binName}` },
					dependencies: options.dependencies ?? {},
				},
				null,
				2,
			),
		);
		writeFileSync(join(packageDir, "bin", options.binName), options.binScriptContent, { mode: 0o755 });
		const tarballPath = join(workDir, "package.tgz");
		execFileSync("tar", ["-czf", tarballPath, "-C", workDir, "package"]);
		return { bytes: readFileSync(tarballPath) };
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

/** Starts the fixture; every dependency named in `options.dependencies` must itself be servable -- pass its own fixture's tarball/version alongside via `extraPackages`, matching real npm dependency resolution. */
export function startNpmRegistryFixture(options: NpmRegistryFixtureOptions, extraPackages: readonly NpmRegistryFixtureOptions[] = []): NpmRegistryFixture {
	const packages = [options, ...extraPackages];
	const tarballs = new Map<string, Buffer>();
	for (const pkg of packages) tarballs.set(pkg.packageName, buildTarball(pkg).bytes);

	let baseUrl = "";
	let tarballDownloads = 0;
	let versionLookups = 0;

	function tarballUrl(name: string, version: string): string {
		return `${baseUrl}/${encodeURIComponent(name)}/-/${name}-${version}.tgz`;
	}

	function packumentFor(pkg: NpmRegistryFixtureOptions): unknown {
		const bytes = tarballs.get(pkg.packageName) as Buffer;
		const shasum = createHash("sha1").update(bytes).digest("hex");
		const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
		const versionDoc = {
			name: pkg.packageName,
			version: pkg.version,
			bin: { [pkg.binName]: `bin/${pkg.binName}` },
			dependencies: pkg.dependencies ?? {},
			dist: { tarball: tarballUrl(pkg.packageName, pkg.version), shasum, integrity },
		};
		return { "dist-tags": { latest: pkg.version }, versions: { [pkg.version]: versionDoc }, ...versionDoc };
	}

	const server: Server<unknown> = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			const segments = url.pathname.split("/").filter(Boolean);

			// GET /<name>/-/<name>-<version>.tgz
			if (segments.length === 3 && segments[1] === "-") {
				const name = decodeURIComponent(segments[0] as string);
				const bytes = tarballs.get(name);
				if (!bytes) return new Response("not found", { status: 404 });
				tarballDownloads++;
				const pkg = packages.find((candidate) => candidate.packageName === name);
				pkg?.onTarballDownload?.();
				return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
			}

			// GET /<name>/<version-or-tag>  (Lector's own abbreviated single-version lookup)
			if (segments.length === 2) {
				const name = decodeURIComponent(segments[0] as string);
				const pkg = packages.find((p) => p.packageName === name);
				if (!pkg) return new Response("not found", { status: 404 });
				versionLookups++;
				return Response.json(packumentFor(pkg));
			}

			// GET /<name>  (the full packument a real `npm install` fetches)
			if (segments.length === 1) {
				const name = decodeURIComponent(segments[0] as string);
				const pkg = packages.find((p) => p.packageName === name);
				if (!pkg) return new Response("not found", { status: 404 });
				const doc = packumentFor(pkg) as Record<string, unknown>;
				return Response.json({ name: pkg.packageName, "dist-tags": doc["dist-tags"], versions: doc.versions });
			}

			return new Response("not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;

	return { url: baseUrl, tarballDownloadCount: () => tarballDownloads, versionLookupCount: () => versionLookups, stop: () => server.stop(true) };
}
