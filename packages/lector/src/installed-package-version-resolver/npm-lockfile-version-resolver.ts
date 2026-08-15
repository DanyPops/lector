// Re-exported for import-path stability -- the real implementation split into
// resolver.ts, resolution-context.ts, limits.ts, and parsers/{npm,pnpm,yarn,bun}-lock.ts,
// one file per independent lockfile-format Strategy.
export { InvalidInstalledPackageVersionRequest, NpmLockfileVersionResolver } from "./resolver.ts";
