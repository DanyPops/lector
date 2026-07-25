# pi-lector

Pi host adapter for Lector: overrides `read`, `write`, and `edit` with a
daemon-backed, hash-guarded filesystem. Requires a running Lector daemon
(`lector serve`) — no auto-spawn.

`populate_symbol_graph` submits bounded background work and waits briefly. If the
graph is still loading, it returns a job id immediately; `job_status` polls that id
later without forcing the agent into a blocking or blind polling loop.
