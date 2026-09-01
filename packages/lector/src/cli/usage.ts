export const USAGE = `Usage:
  lector serve [--workspace <id>]... [--workspace-path <id>=<dir>]... [--dynamic-workspaces]
    at least one --workspace, --workspace-path, or --dynamic-workspaces is required
    --workspace <id>            ephemeral in-memory workspace (data lost on restart)
    --workspace-path <id>=<dir> real directory <dir>, registered under <id>
    --dynamic-workspaces        start with none pre-registered; every workspace is added at
                                 runtime via "lector workspace register" (workspace.registerPath) --
                                 the mode a long-lived background daemon (e.g. lector.service) wants,
                                 since it does not know upfront which project(s) will attach to it
    --lsp-memory-budget-bytes <n> explicit adaptive budget for language-server process trees;
                                 otherwise a finite cgroup v2 memory.high is used when available
    --reserved-foreground-slots <n> warm-index admission slots background population
                                 (workspace.populateSymbolGraph) can never grow into, so it
                                 cannot starve a concurrent interactive query out of every slot;
                                 defaults to 0 (today's shared, unreserved behavior)
    --background-admission-queue-timeout-ms <n> how long a queued background admission waits
                                 for room before failing; defaults to 10000
    --max-queued-background-admissions <n> bounds the background admission queue itself;
                                 defaults to 8
    --absolute-max-active-indexes <n> hard structural ceiling a resource budget's own soft
                                 ceiling can never raise the warm-index count past, independent
                                 of memory; defaults to 32 (or --max-active-symbol-indexes if higher)
  lector service <install|start|stop|restart|status>
    install: writes a user systemd unit (lector serve --dynamic-workspaces), enables + starts it
  lector workspace register <dir> [--json]
  lector workspace release <workspace-id> [--json]
    closes idle workspace resources and unregisters the opaque id; refuses while an index lease,
    background graph job, or live watch still uses the workspace
  lector workspace read <workspace-id> <path> [--json]
  lector workspace edit <workspace-id> <path> --content <text> (--expected-hash <hash> | --create) [--json]
  lector workspace delete <workspace-id> <path> --expected-hash <hash> [--json]
    deletes one file entry, guarded by --expected-hash the same way edit's own guard works
  lector workspace list-directory <workspace-id> [path] [--json]
    immediate children only, not recursive -- omit [path] (or pass "") for the workspace root
  lector workspace create-directory <workspace-id> <path> [--json]
    mkdir -p semantics; a no-op if <path> already exists as a directory
  lector workspace rename-path <workspace-id> <old-path> <new-path> [--json]
    atomic move for a file or directory; rejects if <new-path> already exists
  lector workspace delete-directory <workspace-id> <path> [--json]
    recursive; NOT hash-guarded -- directories have no single content hash to guard with
  lector workspace watch <workspace-id> --pattern <glob> [--json]
    blocks, printing every real matching file change (created/modified/deleted) as it happens
    (Ctrl-C to stop) -- connects to the daemon's PushChannel over a real WebSocket, the same
    channel workspace.watch's own topic is delivered on for any other subscriber
  lector workspace unwatch <watch-id> [--json]
  lector workspace mutation-history <workspace-id> <path> --max-results <n> [--json]
    newest first -- every successful exactEdit/lineEdit/applyPatch/revertMutation on <path> is
    recorded, oldest entries evicted once the per-file bound is exceeded (not durable across a
    daemon restart)
  lector workspace revert-mutation <workspace-id> <entry-id> [--json]
  lector workspace mutation-transaction <workspace-id> <transaction-id> [--json]
  lector workspace revert-mutation-transaction <workspace-id> <transaction-id> [--json]
    restores the file to its exact content immediately before that entry's own mutation --
    refuses if the file has changed since (a real, further-revertible mutation itself, not a
    special case: reverting a revert works)
  lector workspace apply-patch <workspace-id> <path> --patch <unified-diff-text> --expected-hash <hash> [--json]
    applies real unified-diff hunks (as diff -u / git diff produce), whole-file guarded --
    hunk context is searched for near its own line-number hint, tolerating a file that
    shifted slightly since the patch was generated, not trusted as an exact offset
  lector workspace line-edit <workspace-id> <path> --edits <json> [--json]
    --edits is a JSON array of LineEdit objects ({kind:"replace",startLine,endLine,
    expectedStartHash,expectedEndHash,lines} | {kind:"insertBefore"|"insertAfter",atLine,
    expectedHash,lines}) -- finer-grained than exactEdit's whole-file guard: a concurrent
    change to a line no edit references never invalidates this one. All edits in one call
    land atomically, or none do.
  lector workspace symbols <workspace-id> <query> [--seed-file <path>] [--response-format <concise|detailed>] [--json]
  lector workspace definition <workspace-id> <path> <line> <character> [--json]
  lector workspace implementation <workspace-id> <path> <line> <character> [--json]
  lector workspace references <workspace-id> <path> <line> <character> [--include-declaration]
    [--response-format <concise|detailed>] [--json]
  lector workspace hover <workspace-id> <path> <line> <character> [--json]
  lector workspace document-symbols <workspace-id> <path> [--json]
  lector workspace diagnostics <workspace-id> <path> [--json]
  lector workspace diagnostic-delta <workspace-id> <transaction|git> <transaction-id|ref>
    --max-results <n> --max-bytes <n> [--max-depth <n> --max-nodes <n> --max-edges <n>
    --deadline-ms <n> --max-files <n> --max-symbols-per-file <n> --auto-populate] [--json]
  lector workspace call-hierarchy <prepare|incoming|outgoing> <workspace-id> <path> <line> <character> [--json]
  lector workspace type-hierarchy <prepare|supertypes|subtypes> <workspace-id> <path> <line> <character>
    [--max-results <n>] [--max-bytes <n>] [--deadline-ms <n>] [--json]
  lector workspace code-actions preview <workspace-id> <path> <start-line> <start-character> <end-line> <end-character>
    --max-actions <n> --max-edits <n> --max-files <n> --max-bytes <n> --deadline-ms <n>
    [--only <kind,...>] [--include-command-actions] [--json]
  lector workspace code-actions apply <workspace-id> <preview-id> [--json]
    applies only the previewed WorkspaceEdit, hash/version guarded and recorded as an atomic transaction;
    command-only actions require preview opt-in and remain unavailable to guarded apply
  lector workspace impact <workspace-id> (--ref <ref> | --transaction-id <id>) --max-depth <n>
    --max-nodes <n> --max-edges <n> --max-bytes <n> --deadline-ms <n>
    --max-files <n> --max-symbols-per-file <n> [--auto-populate] [--json]
  lector workspace populate-symbol-graph <workspace-id> --max-files <n> --max-symbols-per-file <n>
    [--background] [--wait-ms <n>] [--json]
    --background submits a bounded process-lifetime job; --wait-ms waits briefly for a fast result
  lector job status <job-id> [--json]
  lector job wait <job-id> [--wait-ms <n>] [--json]
    waits up to 300000ms for PushChannel completion; status polling is the disconnect fallback
  lector workspace symbol-graph <reachable-from|edges-from|edges-to> <workspace-id> <path> <line> <character>
    [--max-depth <n>] [--kind <calls|references|contains>] [--json]
    --max-depth is required for reachable-from, ignored for edges-from/edges-to
    reachable-from only: --auto-populate [--max-files <n>] [--max-symbols-per-file <n>] populates once
    if the graph has no completed generation at all for those bounds, before querying -- never retries
    a genuinely partial graph; --max-files/--max-symbols-per-file are required alongside --auto-populate
  lector workspace annotation create <workspace-id> --subtype <s> --title <t> --body <text>
    --anchor <path>:<line>:<character> (repeatable, at least one required) [--json]
    each anchor must resolve to a real, currently-known symbol in the populated graph
    [--auto-populate --max-files <n> --max-symbols-per-file <n>] populates once first if not yet cached
    at those bounds, instead of failing when an anchor falls outside the graph's current scan
  lector workspace annotation get <workspace-id> <annotation-id> [--json]
    live-checks staleness against the current graph/workspace before returning
  lector workspace annotation list <workspace-id> [--subtype <s>] [--status <fresh|stale|scrubbed>] [--query <text>]
    [--max-results <n>] [--json]
  lector workspace annotation refresh <workspace-id> <annotation-id> --subtype <s> --title <t> --body <text>
    --anchor <path>:<line>:<character> (repeatable, at least one required) [--json]
    [--auto-populate --max-files <n> --max-symbols-per-file <n>] uses the same bounded, not-cached-only
    anchor recovery as annotation create
  lector workspace annotation scrub <workspace-id> <annotation-id> [--json]
  lector workspace annotation restore <workspace-id> <annotation-id> [--json]
  lector workspace annotation contain <workspace-id> <parent-id> <child-id> [--json]
    idempotent -- containing an already-contained child is a no-op, not an error
  lector workspace annotation uncontain <workspace-id> <parent-id> <child-id> [--json]
    idempotent -- uncontaining an already-absent relationship is a no-op, not an error
  lector workspace annotation tree <workspace-id> <root-id> --max-depth <n> [--json]
    every annotation reachable via contains from root-id (including root-id itself), BFS-bounded
  lector workspace has-warm-index <workspace-id> [--json]
    never spawns a symbol index -- reports whether one is already warm
  lector workspace map <workspace-id> --max-nodes <n> --max-edges <n> --max-entries <n> --max-bytes <n> [--json]
    ranked, budget-bounded workspace summary (aider-repomap-shaped): the most structurally
    central symbols by PageRank over the populated graph, signature-only, highest-ranked first
  lector workspace cache-status <workspace-id> --max-files <n> --max-symbols-per-file <n> [--json]
  lector workspace reference-based-rename <workspace-id> <from-path> <to-path>
    --max-files <n> --max-symbols-per-file <n> [--json]
    non-LSP: rewrites every static import/export specifier this workspace's own populated symbol
    graph knows references the moved file, then physically moves it -- all atomically, rolled back
    on any failure. Refuses outright (touches nothing) unless the graph is fully "cached" (never
    "partial"/"not-cached") for these exact bounds. Does not follow dynamic import(expr)/
    require(expr) or any plain string reference -- see the returned caveats.
  lector workspace prepare-rename <workspace-id> <path> <line> <character> [--json]
    where/what could be renamed at this position -- null when nothing is renameable there
  lector workspace rename <workspace-id> <path> <line> <character> <new-name> [--json]
    LSP-driven: applies the negotiated server's own WorkspaceEdit atomically across every file it
    touches, validated against a fresh per-file hash snapshot taken immediately before applying
  lector workspace git-status <workspace-id> [--json]
  lector workspace git-log <workspace-id> --max-count <n> [--json]
  lector workspace git-diff <workspace-id> [--ref <ref>] --max-bytes <n> [--json]
  lector workspace git-grep-history <workspace-id> <extended-regex> --commit-offset <n>
    --max-commits <n> --max-matches <n> --max-bytes <n> --deadline-ms <n>
    [--pathspec <glob>]... [--json]
    searches commit trees reachable from all refs in deterministic topological pages; excludes
    binary files and deduplicates exact path/line/text matches while preserving commit provenance
  lector workspace compare-symbol <workspace-id> --path <p> --symbol <name> --from-ref <ref>
    [--to-ref <ref>] --max-bytes <n> [--json]
    tree-sitter syntactic tier only: a real unified diff of one symbol's own declaration text
    between two git refs, or a ref and the current working tree when --to-ref is omitted
  lector workspace repo-fetch <owner>/<repo>[@ref] [--host <host>] [--force-refresh] [--json]
    shallow-clones an external repo into a disk-bounded cache and registers it read-only;
    --force-refresh reclones even when an unexpired cache entry already exists (the "update"
    verb -- for a caller that has already positively confirmed the remote moved)
  lector workspace repo-cache-list --max-results <n> [--host <h>] [--owner <o>] [--repo <r>]
    [--ref <ref>] [--query <text>] [--cursor <c>] [--json]
    lists repo.fetch's own on-disk cache -- no network, no mutation -- filtered by any
    combination of host/owner/repo/ref (exact) and query (case-insensitive substring),
    bounded and paginated via --cursor
  lector workspace repo-cache-evict <owner>/<repo>[@ref] [--host <host>] [--json]
    removes one cached repo checkout from disk and the cache index; refuses if it is still a
    currently-registered workspace
  lector package source <project-dir> <package-name> [--ecosystem <e>] [--version <exact-version>] [--registry <url>] [--json]
    resolves an installed package (--ecosystem npm/pypi/..., default npm) to verified exact
    repository source and registers it read-only
  lector package list-sources [--ecosystem <e>] [--query <text>] --max-results <n> [--cursor <c>] [--json]
    lists every package coordinate this daemon has already resolved to a verified source
    workspace -- no re-resolution, no network -- bounded and paginated via --cursor
  lector package remove-source <ecosystem> <name> <resolved-version> [--registry <url>] [--json]
    removes one resolved-source bookkeeping entry; refuses if it is still a currently-registered
    workspace. Does not delete the underlying repo.fetch disk cache entry -- use
    workspace repo-cache-evict for that, since a monorepo can share one checkout across
    several package coordinates
  lector package clean-sources [--ecosystem <e>] [--json]
    removes every non-in-use resolved-source entry, optionally scoped to one ecosystem;
    reports counts of removed and skipped (still-registered) entries
  lector workspace search-text <workspace-id> <query> --max-matches <n> --max-bytes <n> [--json]
  lector workspace find-files <workspace-id> --pattern <glob> (repeatable, at least one required)
    --max-results <n> --max-bytes <n> [--json]
    patterns are OR'd together -- a file matching any one of them is included
  lector search symbols <query> [--workspace <id>]... [--timeout-ms <n>] [--json]
  lector search text <query> --max-matches <n> --max-bytes <n> [--workspace <id>]... [--timeout-ms <n>] [--json]
  lector search github-repos <query> [--max-results <n>] [--json]
    finds real prior art before writing new code -- candidates are shaped as direct repo-fetch
    inputs (owner/repo/host); GITHUB_TOKEN raises the rate limit from 10 to 30 req/min
  lector search npm-packages <query> [--max-results <n>] [--json]
    candidates are shaped as direct package-source inputs (name, plus the version already returned)
  lector search sourcegraph-code <query> [--max-results <n>] [--json]
    content search across public GitHub via sourcegraph.com -- "which repos actually contain code
    matching X", not repo/package metadata search; each candidate's repository field feeds
    repo-fetch once split on "/"
    fans out across the given --workspace id(s); with none given, every currently-registered
    workspace, daemon-wide -- this daemon is a shared service, so that default can include a
    project a different, concurrent Pi session registered. Prefer explicit --workspace when you
    mean "my own current projects".
    a workspace whose language server is still cold-starting is reported as "loading", not
    silently omitted and not blocking every other workspace's real results
`;
