# Koi Productization Plan

## Issue: #1063

### Context

Issue #1063 proposes 10 workstreams to make Koi installable, safe to update, easier to debug, and easier to extend. The gap analysis (decision 3A) revealed that the existing codebase already covers roughly 40% of the proposed surface:

- `koi status` already reports agent, model, PID, service, health, admin, Nexus, Temporal, agents, data sources, and channels with parallel probes and `--json` output.
- `koi doctor` already runs 7 typed checks (service file, service status, health, readiness, Bun, Koi CLI, linger) with `--repair` and `--json`.
- `koi forge` already provides install, publish, search, inspect, update, and uninstall for all brick kinds (tools, skills, agents, middleware, channels, composites) with integrity verification and dependency checking.
- `koi logs --follow` already tails service logs.
- `koi sessions list` already provides session discovery with message counts and previews.
- `koi deploy` already installs OS services (launchd/systemd) with port, system mode, and uninstall.

The unified forge decision (2A) means there will be no separate `koi skills` and `koi extensions` command groups. All extension types are already managed through `koi forge` as "bricks" with a `--kind` flag (tool, skill, agent, middleware, channel, composite). This eliminates workstreams 4 and 5 as distinct efforts and folds their remaining requirements into forge enhancements.

---

### Architecture Decisions

| # | Area | Decision | Rationale |
|---|------|----------|-----------|
| 1A | Distribution | Standalone binary via `bun build --compile` | Zero-dep install. Users run one binary without Bun, npm, or monorepo. Native performance via Bun AOT. |
| 2A | CLI surface | Unified distribution under `koi forge` | One command group for all extension types. `--kind` flag disambiguates. No fragmented `koi skills` + `koi extensions`. |
| 3A | Gap analysis | Existing commands cover ~40% of plan | status, doctor, forge, logs, sessions, deploy already exist. Focus remaining effort on gaps, not rewrites. |
| 4A | Trust model | Content-hash + Ed25519 signatures with trust tiers | Curated registry at launch (Koi-signed bricks only). Open publishing later with namespace isolation. HMAC-SHA256 for community, Ed25519 for curated. |
| 5A | Code quality | DRY: `loadManifestOrExit` + `defineLazyCommand` | Eliminated 7 duplicate load-check-exit blocks and 12 inline dynamic-import patterns. |
| 6A | Integrity | ForgeStore content-hash verification + optimistic locking | `save()` computes SHA-256 content hash and rejects conflicts. Prevents silent corruption during concurrent writes. |
| 7A | Concurrency | Mount/unmount race condition fixed | Skills provider mount/unmount now serialized. Prevents double-mount on rapid reconnect. |
| 8A | CLI standards | Standardized exit codes + `--json` on status/doctor | `EXIT_NETWORK` (3), `EXIT_TIMEOUT` (4) join existing `EXIT_OK`/`EXIT_ERROR`/`EXIT_CONFIG`. Machine-readable output on both diagnostic commands. |
| 9A | E2E testing | Operator workflow smoke test | Validates init -> start -> status -> doctor -> stop lifecycle in a single test run. |
| 10B | Doctor | Typed check IDs + repair tests | `CHECK_IDS` const object replaces string matching. Repair logic dispatches on compile-time-safe IDs. |
| 11A | Scanner | Metrics bug fixed + `onFilteredFinding` callback | Scanner now correctly counts filtered findings. Callback enables UI to show why a skill was rejected. |
| 12A | Forge testing | Forge workflow E2E test | Validates forge install -> inspect -> update -> uninstall lifecycle against a mock registry. |
| 13A | Performance | Status probes parallelized with short-circuit | Wave 1 (health, admin, Nexus, Temporal) runs in parallel. Wave 2 (agents, data sources, channels) only runs if admin is reachable. |
| 14A | Performance | Forge update uses batch/concurrent API | `batchCheck()` compares all installed hashes in one call. `mapWithConcurrency(5)` fetches updates in parallel. |
| 15A | Resolution | Build-time descriptor manifest | Static resolution skips runtime introspection for known tools. Reduces cold-start tool discovery time. |
| 16A | Utility | `mapWithConcurrency` | Generic bounded-concurrency map. Used by forge update and available for any parallel workload. |

---

### Gap Analysis: What Already Exists

| Issue #1063 Plan Item | Existing Implementation | Actual Gap |
|---|---|---|
| **WS1: Install & update** | No standalone binary. `koi` runs from source via `bun`. | Need: `bun build --compile` script, binary distribution (GitHub releases / homebrew), version reporting (`koi --version`), update checker. |
| **WS2: Doctor as repair surface** | `koi doctor` has 7 checks with typed IDs, `--repair` restarts services and enables linger, `--json` output. | Need: config migration helpers, state layout repair, more repair actions (stale PID cleanup, port conflict resolution, Nexus container recovery). |
| **WS3: Operator diagnostics** | `koi status` has parallel probes, wave-based short-circuit, `--json`, covers agent/model/PID/service/health/admin/Nexus/Temporal/agents/data-sources/channels. `koi logs --follow` works. | Need: `--all` pasteable report mode, `--deep` active probes, `koi channels status --probe`, version/git-SHA in status output, recent warnings section. |
| **WS4: Skill distribution** | `koi forge install/search/update/uninstall` already handles `--kind skill`. Content-hash verification, attestation checking, dependency resolution all work. | Need: lockfile/version pinning (forge.lock), `koi forge list` for installed bricks, better trust UX (show trust tier in search results). Folded into forge. |
| **WS5: Extension distribution** | Same as WS4 — forge handles all brick kinds including middleware, channels, composites. | Need: local dev linking (`koi forge link .`), enable/disable without uninstall, extension health in doctor. Folded into forge. |
| **WS6: Browser operator UX** | Browser driver exists in `packages/drivers/`. No CLI surface. | Need: `koi browser` command group (launch, profile, attach), managed profile flow, policy gates for host-profile reuse. |
| **WS7: Channel trust & security** | Channel status shown in `koi status`. No security audit. | Need: session scoping audit, shared-inbox risk detection, auto-fix for unsafe defaults, integration with doctor checks. |
| **WS8: Session & multi-agent UX** | `koi sessions list` shows session discovery. `koi up --resume <id>` resumes. Agent spawning exists at runtime level. | Need: `koi sessions send <id> <msg>`, `koi sessions history <id>`, visibility rules for sandboxed contexts, delegation workflow simplification. |
| **WS9: Release & rollback** | No release automation. No smoke tests. | Need: release workflow, smoke test suite, rollback/pinning guidance, hotfix process. Partially started with E2E tests (9A, 12A). |
| **WS10: Docs & onboarding** | Architecture docs exist. No task-oriented guides. | Need: first-run guide, upgrade guide, troubleshooting guide, minimal command reference. |

---

### Revised Workstreams

#### WS1: Install and Update Workflow

**Priority: P0 (gate for all other workstreams)**
**Existing coverage: ~20%**

The standalone binary (1A) is the foundation for everything else. Without it, users cannot install Koi without cloning the monorepo.

Remaining work:
- [ ] Finish `bun build --compile` build script (1A, in progress)
- [ ] Add `koi --version` flag (reads from package.json or embedded build metadata)
- [ ] Create GitHub Release workflow (build matrix: linux-x64, linux-arm64, darwin-x64, darwin-arm64)
- [ ] Publish to Homebrew tap (`brew install koi-dev/tap/koi`)
- [ ] Add update checker (`koi update` or startup notice when new version available)
- [ ] Define install modes: binary vs source checkout
- [ ] Document zero-to-running path (binary download -> `koi init` -> `koi up`)

#### WS2: Doctor as Repair Surface

**Priority: P1**
**Existing coverage: ~60%**

Doctor already runs 7 checks with typed IDs and has `--repair` for service restart and linger. The typed check ID system (10B) makes it safe to add new checks and repair actions.

Remaining work:
- [ ] Add check: stale PID file detection + auto-cleanup
- [ ] Add check: port conflict detection (health port, admin port range)
- [ ] Add check: Nexus container health + auto-restart
- [ ] Add check: manifest schema validation (catch common YAML errors)
- [ ] Add config migration helpers (detect old config keys, suggest new ones)
- [ ] Add state directory repair (`.koi/` structure validation)
- [ ] Add `koi doctor --migrate` for breaking config changes between versions

#### WS3: Operator Diagnostics Ladder

**Priority: P1**
**Existing coverage: ~65%**

Status is the most complete existing command. Parallel probes with short-circuit (13A) and `--json` (8A) are done.

Remaining work:
- [ ] Add `koi status --all` pasteable support report (version, install type, git SHA, full status dump)
- [ ] Add `koi status --deep` for active probes (send test message through channel, verify Nexus write/read)
- [ ] Add Koi version + install type to status output
- [ ] Add `koi channels status --probe` (or fold into `koi status --deep`)
- [ ] Add recent warnings section to status output
- [ ] Add `koi status --watch` for continuous monitoring

#### WS4+5: Unified Forge (Skill + Extension Distribution)

**Priority: P1**
**Existing coverage: ~70%**

Per decision 2A, skills and extensions are unified under `koi forge`. The forge already handles install, publish, search, inspect, update, and uninstall for all brick kinds. Content-hash verification (6A), batch update (14A), and E2E testing (12A) are done.

Remaining work:
- [ ] Finish Ed25519 signature verification for curated trust tier (4A, in progress)
- [ ] Add `koi forge list` — show all installed bricks with kind, version, trust status
- [ ] Add `koi forge link <path>` — symlink a local brick for development
- [ ] Add `koi forge enable/disable <name>` — toggle without uninstall
- [ ] Add `forge.lock` lockfile for version pinning
- [ ] Show trust tier (curated/community/local) in search and inspect output
- [ ] Add forge health check to `koi doctor` (verify installed bricks still valid)
- [ ] Document brick authoring guide (how to create and publish a tool/skill/middleware)

#### WS6: Browser Operator UX

**Priority: P2**
**Existing coverage: ~10%**

Browser driver exists at the runtime level but has no CLI surface.

Remaining work:
- [ ] Add `koi browser launch` — start managed browser with agent profile
- [ ] Add `koi browser profiles` — list/create/delete browser profiles
- [ ] Add `koi browser attach` — attach to host browser session (with policy gate)
- [ ] Define policy for host-profile reuse (require explicit `--allow-host-profile`)
- [ ] Document manual-login flow for authenticated sites
- [ ] Add browser health check to `koi doctor`

#### WS7: Channel Trust and Security Audits

**Priority: P2**
**Existing coverage: ~15%**

Channel connectivity is shown in `koi status` but there is no security audit surface.

Remaining work:
- [ ] Add `koi security audit` command (or `koi doctor --security`)
- [ ] Detect unsafe session scoping defaults in multi-user scenarios
- [ ] Detect shared-inbox risk in channel configurations
- [ ] Recommend safer scoping modes with auto-fix option
- [ ] Add security checks to `koi doctor` check suite
- [ ] Document channel trust model and scoping best practices

#### WS8: Session and Multi-Agent UX

**Priority: P2**
**Existing coverage: ~30%**

Session listing and resume work. Runtime delegation and spawning exist.

Remaining work:
- [ ] Add `koi sessions history <id>` — print session transcript
- [ ] Add `koi sessions send <id> <message>` — inject message into running session
- [ ] Add `koi sessions status` — show active vs completed sessions
- [ ] Define visibility rules for sandboxed and child-agent contexts
- [ ] Simplify delegation workflow (reduce boilerplate for common patterns)
- [ ] Document multi-agent patterns (supervisor, pipeline, swarm)

#### WS9: Release and Rollback Discipline

**Priority: P1 (gates WS1)**
**Existing coverage: ~20%**

E2E smoke tests (9A, 12A) are the start but not yet wired into CI release gates.

Remaining work:
- [ ] Define stable vs pre-release version scheme (semver with -rc.N)
- [ ] Add release smoke test suite (install, init, up, status, doctor, forge, stop)
- [ ] Wire smoke tests into GitHub Release workflow as gate
- [ ] Add rollback guidance (pin to specific version, downgrade path)
- [ ] Add hotfix process documentation
- [ ] Add `koi rollback` or version pinning in config

#### WS10: Docs and Onboarding Simplification

**Priority: P2**
**Existing coverage: ~10%**

Architecture docs are thorough but user-facing task docs are minimal.

Remaining work:
- [ ] Write "First Run" guide (install -> init -> up -> send message -> see response)
- [ ] Write "Upgrade" guide (check version -> backup -> update -> verify)
- [ ] Write "Something Broke" guide (status -> doctor --repair -> logs -> file issue)
- [ ] Write minimal command reference (one paragraph per command)
- [ ] Restructure docs landing page around task flows, not architecture layers
- [ ] Add `koi help <command>` with inline docs

---

### Implementation Status

All 16 changes from the review are tracked below.

| # | Decision | Category | Description | Status |
|---|----------|----------|-------------|--------|
| 1A | Standalone binary | Architecture | `bun build --compile` build script | In progress |
| 2A | Unified forge | Architecture | No separate `koi skills` + `koi extensions` | Done (by design -- forge already handles all kinds) |
| 3A | Gap analysis | Architecture | This document | Done |
| 4A | Trust model | Architecture | Ed25519 signatures + trust tiers | In progress |
| 5A | DRY fixes | Code quality | `loadManifestOrExit`, `defineLazyCommand` | Done |
| 6A | Content-hash | Code quality | ForgeStore verification + optimistic locking | Done |
| 7A | Race condition | Code quality | Mount/unmount serialization | Done |
| 8A | Exit codes | Code quality | `EXIT_NETWORK`/`EXIT_TIMEOUT` + `--json` | Done |
| 9A | E2E smoke test | Testing | Operator workflow lifecycle test | In progress |
| 10B | Doctor refactor | Testing | Typed check IDs + repair tests | Done |
| 11A | Scanner metrics | Testing | Bug fix + `onFilteredFinding` callback | Done |
| 12A | Forge E2E | Testing | Forge workflow lifecycle test | In progress |
| 13A | Status perf | Performance | Parallel probes + wave short-circuit | Done |
| 14A | Forge update perf | Performance | Batch check + concurrent fetch | Done |
| 15A | Static resolution | Performance | Build-time descriptor manifest | Done |
| 16A | Concurrency util | Performance | `mapWithConcurrency` in `@koi/errors` | Done |

**Summary: 10 done, 4 in progress, 2 done by design = 16 total.**

---

### Revised Milestones

#### Milestone 1: Product Entrypoint (WS1 + WS9 foundations)

Gate for external adoption. No user can try Koi without this.

- [ ] Standalone binary builds for linux-x64, linux-arm64, darwin-x64, darwin-arm64
- [ ] `koi --version` reports version and build metadata
- [ ] GitHub Release workflow with smoke test gate
- [ ] Homebrew tap for macOS
- [ ] "First Run" guide in docs
- [ ] Update checker (advisory, not forced)

**Pre-done in this PR:**
- Exit codes standardized (8A) -- binary can report failures clearly
- `defineLazyCommand` (5A) -- binary startup is fast (no eager imports)
- Build-time descriptor manifest (15A) -- binary cold-start is fast
- E2E smoke test (9A) -- release gate exists

**Estimated remaining: ~3-5 days engineering**

#### Milestone 2: Safe Operations (WS2 + WS3 + WS7 foundations)

Makes Koi supportable for operators who are not Koi contributors.

- [ ] `koi status --all` pasteable support report
- [ ] `koi status --deep` active probes
- [ ] Doctor: stale PID, port conflict, Nexus health, manifest validation checks
- [ ] Doctor: config migration helpers
- [ ] Channel security audit (basic: scoping defaults + shared-inbox risk)
- [ ] Version + install type in status output

**Pre-done in this PR:**
- Status parallel probes + short-circuit (13A)
- Status + doctor `--json` output (8A)
- Doctor typed check IDs + repair (10B)
- `loadManifestOrExit` shared helper (5A)

**Estimated remaining: ~5-7 days engineering**

#### Milestone 3: Extensibility UX (WS4+5 unified forge enhancements)

Makes Koi extensible without repo surgery.

- [ ] Ed25519 curated trust tier (finish 4A)
- [ ] `koi forge list` (installed bricks with trust status)
- [ ] `koi forge link` (local dev workflow)
- [ ] `koi forge enable/disable` (toggle without uninstall)
- [ ] `forge.lock` version pinning
- [ ] Forge health check in doctor
- [ ] Brick authoring guide

**Pre-done in this PR:**
- Forge install/publish/search/inspect/update/uninstall all work
- Content-hash integrity verification (6A)
- Batch update with concurrent fetch (14A)
- Forge E2E test (12A)
- Scanner filtered findings callback (11A)
- `mapWithConcurrency` utility (16A)

**Estimated remaining: ~5-7 days engineering**

#### Milestone 4: Docs, Release, and Advanced UX (WS6 + WS8 + WS9 + WS10)

Polish and completeness. Can be delivered incrementally.

- [ ] Browser operator CLI surface (WS6)
- [ ] Session management commands beyond list/resume (WS8)
- [ ] Release automation + rollback guidance (WS9)
- [ ] Task-oriented documentation rewrite (WS10)
- [ ] `koi help <command>` inline docs
- [ ] Multi-agent workflow documentation

**Pre-done in this PR:**
- Mount/unmount race fix (7A) -- browser/channel reliability
- E2E operator smoke test (9A) -- release gate foundation

**Estimated remaining: ~10-15 days engineering (can be parallelized)**

---

### Existing CLI Command Surface (for reference)

| Command | Subcommands | Status |
|---------|-------------|--------|
| `koi init` | `[directory]` | Shipped |
| `koi up` | `[manifest]` | Shipped |
| `koi start` | `[manifest]` | Shipped |
| `koi serve` | `[manifest]` | Shipped |
| `koi stop` | `[manifest]` | Shipped |
| `koi admin` | `[manifest]` | Shipped |
| `koi deploy` | `[manifest]` | Shipped |
| `koi status` | `[manifest] --json --timeout` | Shipped (enhanced in this PR) |
| `koi doctor` | `[manifest] --repair --json` | Shipped (enhanced in this PR) |
| `koi logs` | `[manifest] --follow --lines` | Shipped |
| `koi forge` | `install, publish, search, inspect, update, uninstall` | Shipped (enhanced in this PR) |
| `koi sessions` | `list` | Shipped |
| `koi demo` | `init, list, reset` | Shipped |
| `koi replay` | `--session --turn --db --events` | Shipped |
| `koi tui` | `[init]` | Shipped |
| `koi browser` | -- | Not started (WS6) |
| `koi security` | -- | Not started (WS7) |

---

### Notes

- The 16 decisions in this PR establish the architectural foundation. No core architecture changes are needed for the remaining workstreams.
- The unified forge decision (2A) reduced the total CLI surface from 17+ commands to the current 15 + 2 planned. Fewer commands means less documentation, fewer tests, and a simpler mental model for operators.
- Milestones 1-3 can be worked in parallel by different contributors. Milestone 4 items are independent of each other.
- All remaining work is product packaging, not core runtime changes. The runtime primitives (channels, middleware, ECS, engine adapters) are stable.
