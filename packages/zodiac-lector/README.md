# @danypops/zodiac-lector

Package-owned Lector contribution for Zodiac. It registers only:

- `lector.workspace.open`
- `lector.file.open`
- `lector.file.save`
- `lector.search.text` and `lector.search.files`
- `lector.symbol.hover`, `lector.symbol.definition`, and `lector.symbol.references`
- `lector.diagnostics.show`
- `lector.call-graph.prepare`, `lector.call-graph.incoming`, `lector.call-graph.outgoing`, and `lector.call-graph.reachable`
- `lector.git.status`, `lector.git.log`, `lector.git.diff`, and `lector.git.compare-symbol`
- the bounded `lector:` workspace/tree/text/semantic/call-graph/Git resource provider

The contribution connects to an authenticated running Lector daemon. Workspace identity is explicit, file paths remain workspace-relative, and every resource read requires byte and entry bounds. Text projections expose Lector's host-neutral `GuardedLiveBuffer`; saves use the last observed content hash and preserve dirty local text when an external write makes that guard stale. Semantic projections preserve Lector provenance, explicit ready/degraded/stale states, and UTF-16 position semantics without exposing LSP wire types. Call-graph projections distinguish live code intelligence from the persisted symbol graph, use stable opaque node identities and openable declaration locations, and expose depth/node/edge/byte/deadline truncation. Read-only Git projections expose branch/status, bounded history, structured diff hunks, exact revisions, symbol comparisons, and openable working-tree locations; Lector owns Git parsing and typed non-repository, bad-revision, binary, detached, renamed, deleted, and truncated outcomes. It does not expose force-directed rendering, unbounded graphs, Git mutation, annotations, package-source, repository-cache, React, or shell behavior.

This PoC vendors the exact packed `@zodiac/protocol@0.0.1` artifact inside this package; it never depends on a machine-local absolute path.
