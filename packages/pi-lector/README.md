# pi-lector

Pi host adapter for Lector: overrides `read`, `write`, and `edit` with a
daemon-backed, hash-guarded filesystem. Requires a running Lector daemon
(`lector serve`) — no auto-spawn.

```bash
pi install npm:@danypops/pi-lector
```

`package_source` resolves an installed npm package through its lockfile and registry metadata, verifies an exact Git commit, and registers the package source read-only for `search_code`, `find_symbols`, and the semantic tools.

`populate_symbol_graph` submits bounded background work and waits briefly. If the
graph is still loading, it returns a job id immediately; `job_status` polls that id
later without forcing the agent into a blocking or blind polling loop.

When a session starts inside a Git repository, pi-lector checks a durable, bounded
source-content manifest without blocking startup. The footer reports not cached,
caching, or cached; completion also emits a one-shot notification. Session shutdown
stops polling, and the agent receives each state transition once in its context.
