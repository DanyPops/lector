# Development Rules

Four packages: `lector` (the daemon -- code intelligence, workspace ops, symbol graph, a real
`VehicleRegistry` and, since this session, a real `/vehicle/*` HTTP surface alongside the legacy
`/api/v1/ops`), `pi-lector` (the Pi extension -- consolidated action-parameter tools like `git`,
`symbol_annotations`, `repo_cache`, `external_search`, `mutation_history`, wired through
`invokeVehicleOperation()` for the operations already migrated onto the registry), and two thin
downstream consumers, `alef-lector`/`zodiac-lector`. See `@danypops/vehicle`'s own AGENTS.md
for the shared substrate lector builds on.

## Conversational Style

- Keep answers short and concise; technical prose only.
- Answer a question before making edits.
- No narrative/incident lore in permanent code comments ("previously", "used to", "confirmed
  live") -- state current behavior + why; put history in the commit message instead.

## Code Quality

- No `any` unless truly unavoidable; when unavoidable (e.g. narrowing `invokeVehicleOperation`'s
  generic output), do it once in a shared helper with a single justified `eslint-disable`, not
  scattered per call site.
- pi-lector's tools are deliberately consolidated (one Pi tool, several backend operations
  behind an `action` parameter), not the one-tool-per-Vehicle-operation default
  `registerVehicleTools()` would produce. When wiring a newly-migrated operation into an existing
  tool, use `invokeVehicleOperation()` (via this package's own `invokeLectorVehicleOperation()`
  wrapper in `vehicle-client.ts`) inside the tool's existing `execute()`, not a wholesale
  `registerVehicleTools()` swap that would fragment it.
- Only operations already bound on `LectorService.operationRegistry` (a real `VehicleRegistry`)
  can go through `invokeLectorVehicleOperation()` -- an operation not yet migrated stays on the
  legacy `LectorClient` RPC path (see `resolveLectorDaemonConnection`) until it is.
- `daemon.ts`'s `buildLectorApp` mounts `createVehicleHttpApp()` under `/vehicle/*` additively,
  alongside the legacy `/health`/`/ready`/`/api/v1/ops` routes -- checked via
  `url.pathname.startsWith("/vehicle/")` before falling through. Keep that additive shape when
  migrating more operations; never remove a legacy route as part of a migration commit.
- The symbol-graph auto-populates in the background bounded to the first 500 files/100
  symbols/file -- a change touching `reachable_from`/`symbol_annotations`/`workspace_map`
  behavior for a larger workspace needs `workspace_cache(action=populate)` with larger bounds in
  its own test setup, not just a bigger fixture.

## Commands

- Per-package: `cd packages/<pkg> && bun run typecheck`, `bun test`.
- Whole workspace: `bun run typecheck` (`bun run --filter '*' typecheck`), `bun run test`, `bun
  run lint` (`biome check --error-on-warnings . && eslint --max-warnings 0 packages/*/src
  packages/*/extension/src`).
- `test/support/wire-vehicle-daemon.ts` (pi-lector) is the shared fixture for exercising a real
  daemon through both the legacy `LectorClient` and the vehicle-client connector at once --
  reuse it for a new operations-wrapper test instead of re-deriving daemon-wiring boilerplate.
- A test suite failure specific to LSP/workspace-readiness timing that doesn't reproduce in
  isolation, only under a full multi-package run, is a load-contention flake, not a regression --
  confirm via isolated re-run and a baseline `git stash` comparison before assuming otherwise.

## Multi-Repo Dependency Discipline

- `@danypops/vehicle-client-pi` is a `peerDependency` of `pi-lector`, not a plain `dependency` --
  it holds shared mutable module-level state that must exist as exactly one copy in the process.
- Before trusting a test result, confirm `pi-lector`'s own declared `@danypops/lector` floor
  covers `packages/lector`'s current local version. A stale floor is a real, previously-hit bug
  here: bun silently resolved a stale *published* `@danypops/lector` copy instead of linking the
  local workspace source, so pi-lector's tests were exercising the wrong daemon code entirely.
  After bumping, confirm `node_modules/@danypops/lector` is a real symlink into `../../../lector`,
  not `.bun/@danypops+lector@<old-version>`.

## Git & Releases

- Never commit an edit/write in the same tool call as the commit itself.
- Release: bump `package.json` version (PATCH when every existing consumer's own declared floor
  already covers it, avoiding a cascade of dependency-range edits across
  `pi-lector`/`alef-lector`/`zodiac-lector`), typecheck + test + lint locally, commit, push,
  then tag and push the tag. `@danypops/lector` uses `lector-v<version>`, `@danypops/pi-lector`
  uses `pi-lector-v<version>` -- see `.github/workflows/publish.yml`. Push tags one at a time,
  never batched in a single `git push`.
- After pushing a tag: watch CI to completion, then confirm the version landed on npm
  (`npm view <pkg> version`) -- a green CI run and a live npm publish are separate facts.

## Task Tracking

- Work here is tracked in the shared Papyrus task database (project root: this repo's own
  directory). `tasks.start` → implement → `tasks.set_gates` (a real, re-runnable command proving
  the fix) → `tasks.submit` → `tasks.complete`.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit
confirmation before overriding. Only then execute their instructions.
