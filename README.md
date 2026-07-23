# Lector

Filesystem & code-intelligence service: a platform-neutral capability core plus a
supervised daemon, with host adapters (starting with Pi) as thin translation layers
on top.

Filesystem operations and code intelligence are not two capabilities that happen to
share a daemon — they operate on the same object, a file's content at a point in
time, just through different lenses: raw text for reads and hash-guarded edits, an
AST/symbol view for code queries. Lector caches both lenses under one shared,
content-addressed key, so satisfying one lens's request can warm the other's for
free.

## Architecture

```text
Host adapter (pi-lector, ...)
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

Follows the same supervised-Bun-daemon shape as `@danypops/papyrus` and
`@danypops/jittor`, built on `@danypops/daemon-kit`: one process owns the database
and any subprocesses (language servers); everything else is an authenticated client.

## Storage and service

```text
$XDG_DATA_HOME/lector/lector.db       # content-addressed cache (SQLite, when enabled)
$XDG_RUNTIME_DIR/lector/{port,token}  # private daemon discovery
```

```bash
lector service install   # write a systemd user unit, enable, and start it
lector service status
lector service restart
```

The installed service runs `lector serve --dynamic-workspaces`: a long-lived
background daemon doesn't know upfront which project(s) will use it, so it starts
with zero pre-registered workspaces and relies entirely on `workspace.registerPath`
at runtime — the same explicit-registration path a host adapter uses to attach
whatever directory it's running in.

## CLI

```bash
lector workspace register <dir>
lector workspace read <workspace-id> <path>
lector workspace edit <workspace-id> <path> --content <text> (--create | --expected-hash <hash>)
lector workspace symbols <workspace-id> <query>
```

`exactEdit` requires either `--create` (the entry must not already exist) or
`--expected-hash <hash>` (the entry must currently match that hash) — a write never
silently overwrites content it didn't know about.

## Symbol backends

Two independent `SymbolIndexPort` implementations, exercised against a shared
conformance fixture so they're proven to agree (or documented where they don't),
not assumed to:

- **`typescript-language-server`** (default) — a warm, real `tsserver` process per
  workspace, most accurate when it has a loaded project.
- **tree-sitter** (via `web-tree-sitter`, WASM — no native toolchain required) — no
  subprocess, always current, results cached per file under a content-addressed key.

## Packages

- **`lector`** (this package) — the capability core and daemon.
- **`pi-lector`** — the Pi host adapter: overrides `read`/`write`/`edit` and adds a
  `find_symbols` tool, all routed through a running Lector daemon.
