# pi-lector

Pi host adapter for Lector: overrides `read`, `write`, and `edit` with a
daemon-backed, hash-guarded filesystem. Requires a running Lector daemon
(`lector serve`) — no auto-spawn.

```bash
pi install npm:@danypops/pi-lector
```

`package_source` resolves an installed npm package through its lockfile and registry metadata, verifies an exact Git commit, and registers the package source read-only for `search_code`, `find_symbols`, and the semantic tools.

Symbol and semantic tool results identify their backend and fidelity. `typescript-language-server` results are semantic; compiler or parser fallback results are structural and list their limitations.

Every workspace's symbol graph auto-populates in the background the moment any tool
first touches it -- reachable_from, workspace_map, reference_based_rename, and
symbol_annotations all return an empty or refusing result rather than an error if
it's still building, instead of requiring an explicit "start indexing" call.

When a session starts inside a Git repository, pi-lector checks a durable, bounded
source-content manifest without blocking startup. The footer reports not cached,
caching, or cached across every workspace touched so far this session; completion
also emits a one-shot notification. Session shutdown stops polling, and the agent
receives each state transition once in its context.

For an explicit, custom-bound population outside of Pi (a larger scan than the
default 500 files / 100 symbols per file), use `lector workspace populate-symbol-graph`
and `lector job status` directly.
