import type { PackageSourceBounds, PackageSourceOutcome, PackageSourceRequest } from "./package-source.ts";
import type { PackageSourceResolverPort } from "./resolver-port.ts";

/**
 * Dispatches to whichever configured resolver actually supports the request's own ecosystem --
 * each real resolver (npm, pypi, ...) already reports `unsupported-ecosystem` for a request it
 * doesn't own (see NpmPackageSourceResolver/PypiPackageSourceResolver's own first check), so this
 * composite just tries each in order and returns the first non-`unsupported-ecosystem` outcome.
 */
export class CompositePackageSourceResolver implements PackageSourceResolverPort {
	private readonly resolvers: readonly PackageSourceResolverPort[];

	constructor(resolvers: readonly PackageSourceResolverPort[]) {
		this.resolvers = resolvers;
	}

	async resolve(request: PackageSourceRequest, bounds: PackageSourceBounds): Promise<PackageSourceOutcome> {
		for (const resolver of this.resolvers) {
			const outcome = await resolver.resolve(request, bounds);
			if (outcome.status !== "unavailable" || outcome.code !== "unsupported-ecosystem") return outcome;
		}
		return { status: "unavailable", code: "unsupported-ecosystem" };
	}
}
