# @danypops/lector

The capability core and daemon half of [Lector](../../README.md) -- domain,
ports, adapters, and the CLI/systemd service. See the repo root README for
the overall architecture and how `packages/pi-lector` fits in.

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
lector workspace populate-symbol-graph <workspace-id> --max-files <n> --max-symbols-per-file <n> --background --wait-ms 500
lector job status <job-id>
lector workspace cache-status <workspace-id> --max-files <n> --max-symbols-per-file <n>
```

Background jobs are process-lifetime and bounded. A daemon restart or retention
expiry makes an old id unavailable; `job status` reports that explicitly. A running
scan returns its job id and an actionable still-loading state instead of blocking
the caller.

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

