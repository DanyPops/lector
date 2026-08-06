# @danypops/alignment-lector

Package-owned Lector contribution for Alignment. It registers only:

- `lector.workspace.open`
- `lector.file.open`
- the read-only `lector:` workspace/tree/text resource provider

The contribution connects to an authenticated running Lector daemon. Workspace identity is explicit, file paths remain workspace-relative, and every resource read requires byte and entry bounds. It does not expose editing, code intelligence, graph, Git, annotations, package-source, repository-cache, React, or shell behavior.

This PoC vendors the exact packed `@alignment/surface-protocol@0.0.1` artifact inside this package; it never depends on a machine-local absolute path.
