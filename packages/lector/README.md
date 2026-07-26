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
lector package source <project-dir> <package-name> [--version <exact-version>] [--registry <url>] [--json]
```

Background jobs are process-lifetime and bounded. A daemon restart or retention
expiry makes an old id unavailable; `job status` reports that explicitly. A running
scan returns its job id and an actionable still-loading state instead of blocking
the caller.

`package source` resolves the installed version from npm, pnpm, Yarn, or Bun lockfiles, then verifies registry repository metadata against an exact Git ref, commit, and source `package.json`. Missing, ambiguous, or mismatched source fails closed. Verified package directories are registered read-only. Private registry requests use `NPM_TOKEN`; output reports only that variable name when authentication is required.

`exactEdit` requires either `--create` (the entry must not already exist) or
`--expected-hash <hash>` (the entry must currently match that hash) — a write never
silently overwrites content it didn't know about.

## Symbol backends

Three independent `SymbolIndexPort` implementations use one result DTO with explicit provenance and truncation:

- **`typescript-language-server`** is semantic authority for identity, definitions, references, implementations, hover, diagnostics, symbols, and calls.
- **TypeScript compiler** extracts bounded structural declarations from cold, malformed, or partially configured projects. It does not claim cross-file identity.
- **tree-sitter** extracts bounded structural declarations and caches them by content hash. It does not claim type or language-server identity.

File-position operations dispatch by extension and seed a cold server with the requested file. Workspace symbol search and graph population detect every enabled language, merge results deterministically, and retain per-symbol and per-backend provenance; one failed backend produces an explicit partial result instead of hiding successful languages. Bash remains explicit-file-only until its vulnerable upstream dependency chain is removed; generic YAML is explicit-file-only because lockfiles and data files do not establish a workspace language.

Symbol results report `fidelity`, `backend`, `authority`, `freshness`, `limitations`, `truncated`, and composite `sources`/`completeness` when applicable. Language-server messages, pending requests, opened files, file bytes, settling, parser files, parser nodes, parser bytes, language indexes, and returned symbols are bounded.

