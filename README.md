# pi-lector

Pi host adapter for Lector: overrides `read`, `write`, and `edit` with a
daemon-backed, hash-guarded filesystem. Requires a running Lector daemon
(`lector serve`) — no auto-spawn.
