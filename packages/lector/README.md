# @danypops/lector

The capability core and daemon half of [Lector](../../README.md) -- domain,
ports, adapters, and the CLI/systemd service. See the repo root README for
the overall architecture and how `packages/pi-lector` fits in.

## Install

Requires Bun and systemd user services on Linux.

```bash
bun add --global @danypops/lector
lector service install
```

The CLI and the service it installs are one versioned unit: update the global package, then rerun `lector service install`. Do not combine that service with a separately managed Pi/Armada installation. Pi/Armada deployments instead update `@danypops/lector` under `~/.pi/agent/npm` and restart `armada-lector.service`. The published CLI starts through a dependency-light bootstrap, so an incompatible hoisted Vehicle dependency reports this reconciliation guidance rather than a raw ESM missing-export exception.

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

Warm language-server admission uses a finite cgroup v2 `memory.high` when the service has one, subtracting the daemon's measured startup baseline to obtain the LSP budget. `memory.current`, `memory.events`, `memory.max`, and PSI `memory.pressure` drive bounded pressure levels and delayed recovery. An operator can instead set `LECTOR_LSP_MEMORY_BUDGET_BYTES` or pass `lector serve --lsp-memory-budget-bytes <n>`. Without either an explicit budget or finite `memory.high`, Lector retains its fixed conservative pool limits.

## CLI

```bash
lector workspace register <dir>
lector workspace read <workspace-id> <path>
lector workspace edit <workspace-id> <path> --content <text> (--create | --expected-hash <hash>)
lector workspace symbols <workspace-id> <query>
lector workspace populate-symbol-graph <workspace-id> --max-files <n> --max-symbols-per-file <n> --background --wait-ms 500
lector job wait <job-id> [--wait-ms <n>]
lector job status <job-id>
lector workspace cache-status <workspace-id> --max-files <n> --max-symbols-per-file <n>
lector package source <project-dir> <package-name> [--version <exact-version>] [--registry <url>] [--json]
```

Background jobs are process-lifetime and bounded. A daemon restart or retention
expiry makes an old id unavailable; `job status` reports that explicitly. `job wait`
subscribes to the daemon's completion channel and uses bounded status polling only while
push delivery is unavailable. A running scan returns its job id instead of blocking the
submitting call.

`package source` resolves the installed version from npm, pnpm, Yarn, or Bun lockfiles, then verifies registry repository metadata against an exact Git ref, commit, and source `package.json`. Missing, ambiguous, or mismatched source fails closed. Verified package directories are registered read-only. Private registry requests use `NPM_TOKEN`; output reports only that variable name when authentication is required.

`exactEdit` requires either `--create` (the entry must not already exist) or
`--expected-hash <hash>` (the entry must currently match that hash) — a write never
silently overwrites content it didn't know about.

## Symbol backends

Three independent `SymbolIndexPort` implementations use one result DTO with explicit provenance and truncation:

- **`typescript-language-server`** is semantic authority for identity, definitions, references, implementations, hover, diagnostics, symbols, and calls.
- **TypeScript compiler** extracts bounded structural declarations from cold, malformed, or partially configured projects. It does not claim cross-file identity.
- **tree-sitter** extracts bounded structural declarations and caches them by content hash. It does not claim type or language-server identity.

File-position operations dispatch by extension and seed a cold server with the requested file. Workspace symbol search and graph population detect every enabled language, merge results deterministically, and retain per-symbol and per-backend provenance. Backend and file-level semantic failures produce bounded partial results without discarding successful languages or files. Bash and generic YAML stay explicit-file-only: a stray `.sh`/`.yaml` file shouldn't spawn a whole extra language server for every polyglot workspace. System servers resolve from the daemon `PATH` first. `gopls` then checks a bounded login shell and Go's own `GOBIN`/`GOPATH`; `LECTOR_GOPLS_PATH` provides an explicit absolute-path override. If absent, Lector installs supported `rust-analyzer` and `clangd` release binaries into its daemon data directory and retries once. `bash-language-server` stays PATH-only so Lector does not ship its vulnerable dependency chain.

Symbol results report `fidelity`, `backend`, `authority`, `freshness`, `limitations`, `truncated`, and composite `sources`/`completeness` when applicable. Language-server messages, pending requests, opened files, file bytes, settling, parser files, parser nodes, parser bytes, language indexes, and returned symbols are bounded.

