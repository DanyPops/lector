/**
 * A minimal, real, local GitHub-releases-API-shaped server for testing the GitHub-release
 * provisioning installer for real -- no live network. Serves the release JSON at
 * /repos/<repo>/releases/latest|tags/<tag> and each named asset's real bytes, matching real
 * GitHub's own shape closely enough for resolveGithubReleaseInstall's own parsing.
 */
import type { Server } from "bun";

export interface GithubReleaseFixtureAsset {
	readonly name: string;
	readonly bytes: Buffer;
}

export interface GithubReleaseFixtureOptions {
	readonly repo: string;
	readonly tagName: string;
	readonly assets: readonly GithubReleaseFixtureAsset[];
}

export interface GithubReleaseFixture {
	readonly apiBaseUrl: string;
	stop(): void;
}

export function startGithubReleaseFixture(options: GithubReleaseFixtureOptions): GithubReleaseFixture {
	let baseUrl = "";

	const server: Server<unknown> = Bun.serve({
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			const segments = url.pathname.split("/").filter(Boolean);

			// GET /repos/<owner>/<repo>/releases/latest  or  /releases/tags/<tag>
			if (segments.length >= 4 && segments[0] === "repos" && segments[3] === "releases") {
				const repo = `${segments[1]}/${segments[2]}`;
				if (repo !== options.repo) return new Response("not found", { status: 404 });
				const isTags = segments[4] === "tags";
				const requestedTag = isTags ? segments[5] : undefined;
				if (requestedTag !== undefined && requestedTag !== options.tagName) return new Response("not found", { status: 404 });
				return Response.json({
					tag_name: options.tagName,
					assets: options.assets.map((asset) => ({ name: asset.name, browser_download_url: `${baseUrl}/download/${asset.name}` })),
				});
			}

			// GET /download/<assetName>
			if (segments.length === 2 && segments[0] === "download") {
				const asset = options.assets.find((candidate) => candidate.name === segments[1]);
				if (!asset) return new Response("not found", { status: 404 });
				return new Response(asset.bytes, { headers: { "content-type": "application/octet-stream" } });
			}

			return new Response("not found", { status: 404 });
		},
	});
	baseUrl = `http://127.0.0.1:${server.port}`;

	return { apiBaseUrl: baseUrl, stop: () => server.stop(true) };
}
