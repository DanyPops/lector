# alef-lector

Alef host adapter for Lector: `WorkspaceFilesystemPort`, `CodeIntelligencePort`,
`CallGraphPort`, and `WorkspaceGitPort` implementations backed by a running Lector
daemon (`lector serve` — no auto-spawn). Unlike `pi-lector`, this package targets
Node consumers, not just Bun: it depends only on Lector's client surface
(`connectLectorClient`), never the daemon or its adapters, and ships a real
compiled `dist/` (JS + `.d.ts`) so a Node/tsc project can depend on it without
resolving `@danypops/lector`'s own raw-TypeScript, Bun-native source.

## Build

```bash
bun install
npm run build   # bun build (JS) + tsc -b (declarations)
```

## Test

```bash
bun test
```

Tests boot a real, isolated Lector daemon per test (in-process, via
`startLectorDaemon`) — no live system daemon required.
