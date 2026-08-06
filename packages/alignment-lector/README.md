# @danypops/alignment-lector

Package-owned Lector contribution for Alignment. It registers only:

- `lector.workspace.open`
- `lector.file.open`
- `lector.file.save`
- `lector.search.text` and `lector.search.files`
- `lector.symbol.hover`, `lector.symbol.definition`, and `lector.symbol.references`
- `lector.diagnostics.show`
- `lector.call-graph.prepare`, `lector.call-graph.incoming`, `lector.call-graph.outgoing`, and `lector.call-graph.reachable`
- the bounded `lector:` workspace/tree/text/semantic/call-graph resource provider

The contribution connects to an authenticated running Lector daemon. Workspace identity is explicit, file paths remain workspace-relative, and every resource read requires byte and entry bounds. Text projections expose Lector's host-neutral `GuardedLiveBuffer`; saves use the last observed content hash and preserve dirty local text when an external write makes that guard stale. Semantic projections preserve Lector provenance, explicit ready/degraded/stale states, and UTF-16 position semantics without exposing LSP wire types. Call-graph projections distinguish live code intelligence from the persisted symbol graph, use stable opaque node identities and openable declaration locations, and expose depth/node/edge/byte/deadline truncation. It does not expose force-directed rendering, unbounded graphs, Git, annotations, package-source, repository-cache, React, or shell behavior.

This PoC vendors the exact packed `@alignment/surface-protocol@0.0.1` artifact inside this package; it never depends on a machine-local absolute path.
