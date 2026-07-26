# Lector

Filesystem & code-intelligence service: a platform-neutral capability core
plus a supervised daemon, with host adapters (starting with Pi) as thin
translation layers on top.

Filesystem operations and code intelligence are not two capabilities that
happen to share a daemon — they operate on the same object, a file's content
at a point in time, just through different lenses: raw text for reads and
hash-guarded edits, an AST/symbol view for code queries. Lector caches both
lenses under one shared, content-addressed key, so satisfying one lens's
request can warm the other's for free.

## Packages

- **[`packages/lector`](packages/lector)** — the capability core and daemon:
  domain, ports, adapters (local filesystem, `typescript-language-server`,
  tree-sitter, SQLite content cache), and the CLI/systemd service.
- **[`packages/pi-lector`](packages/pi-lector)** — the Pi host adapter:
  overrides `read`/`write`/`edit` and adds symbol, search, Git, repository, and verified package-source tools, all routed through a running Lector daemon.

A future `alef-lector` (the Alef host adapter) would join this workspace the
same way, depending on `packages/lector` without duplicating any of its
domain behavior.

## Architecture

```text
Host adapter (packages/pi-lector, ...)
      ↓
authenticated loopback client
      ↓
Lector daemon (auth, dispatch, cache/index generations)
      ↓
domain: rawRead / exactEdit / findWorkspaceSymbols
      ↓
ports: WorkspacePort, SymbolIndexPort, ContentCachePort
      ↓
adapters: local filesystem, typescript-language-server, tree-sitter (WASM), SQLite
```

A supervised Bun daemon built on `@danypops/daemon-kit`: one process owns
the database and any subprocesses (language servers); everything else is
an authenticated client.

## Development

This is a Bun workspace (`packages/*`) — one `bun install` at the repo root
links `pi-lector`'s dependency on `lector` locally, no publish needed to
develop both together.

```bash
bun install     # from the repo root
bun test        # runs every package's tests
bun run typecheck
```

See each package's own README for its CLI, service, and API surface.
