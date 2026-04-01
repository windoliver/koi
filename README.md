<p align="center">
  <img src="logo.svg" alt="Koi" width="200" />
</p>

<h1 align="center">Koi</h1>

<p align="center">
  <strong>The self-extending agent operating system.</strong><br/>
  7 contracts. One YAML file.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-Strict-blue?logo=typescript" alt="TypeScript Strict" />
  <img src="https://img.shields.io/badge/Runtime-Bun%201.3-f9f1e1?logo=bun" alt="Bun 1.3" />
  <img src="https://img.shields.io/badge/PRs-Welcome-brightgreen" alt="PRs Welcome" />
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#development">Development</a> &middot;
  <a href="#contributing">Contributing</a> &middot;
  <a href="docs/user-guide.md">Docs</a>
</p>

---

> **v2 scaffold** — This repo contains the kernel foundation for Koi v2. The CLI, runtime,
> channels, and feature packages from v1 are archived under `archive/v1/` (see the
> `v1-archive` git tag for the full v1 codebase). The v2 scaffold retains the L0 contracts,
> L1 engine, and 11 L0u utility packages as the buildable, testable foundation for the rewrite.

## Quickstart

```bash
git clone https://github.com/windoliver/koi.git
cd koi
bun install
bun run build
bun run test
```

The scaffold currently contains 15 packages across 3 subsystems (kernel, lib, mm).
All 705 tests pass. The CLI and runtime will be rebuilt on this foundation in subsequent phases.

## Architecture

Koi uses a strict five-layer architecture. Layer violations are build errors.

```
L0  @koi/core        Interfaces-only kernel. Types + contracts. Zero logic. Zero deps.
L0u 11 utility pkgs   Pure functions — errors, validation, hashing. Zero business logic.
L1  @koi/engine       Kernel runtime. Guards, lifecycle, middleware composition.
L2  @koi/*            Feature packages. Each depends on L0/L0u only. Never on L1 or peers.
L3  Meta-packages     Convenience bundles (e.g., @koi/starter = L0 + L1 + selected L2).
```

### 7 Contracts

The kernel defines 7 extension contracts — the syscall table of the agent OS:

| Contract | Purpose | Surface |
|----------|---------|---------|
| **Middleware** | Sole interposition layer for model/tool calls | 7 optional hooks |
| **Message** | Inbound/outbound data format | `ContentBlock[]` |
| **Channel** | I/O interface to users | `send()` + `onMessage()` |
| **Resolver** | Discovery of tools/skills/agents | `discover()` + `load()` |
| **Assembly** | What an agent IS (manifest) | Declarative YAML config |
| **Engine** | Swappable agent loop | `stream()` |
| **AgentRegistry** | Agent lifecycle management | CAS transitions + `watch()` |

Plus ECS composition: Agent = entity, Tool = component, Middleware = system.

### Retained Packages (v2 Scaffold)

| Layer | Packages |
|-------|----------|
| **L0** | `@koi/core` |
| **L1** | `@koi/engine`, `@koi/engine-compose`, `@koi/engine-reconcile` |
| **L0u** | `@koi/edit-match`, `@koi/errors`, `@koi/event-delivery`, `@koi/execution-context`, `@koi/file-resolution`, `@koi/git-utils`, `@koi/hash`, `@koi/session-repair`, `@koi/shutdown`, `@koi/token-estimator`, `@koi/validation` |

<details>
<summary><strong>Linux → Koi mental model</strong></summary>

Every Koi concept maps 1:1 to a Linux kernel equivalent:

| Linux | Koi | Where it lives |
|-------|-----|----------------|
| `task_struct` | `ProcessDescriptor` | L0 `@koi/core` |
| Process state (RUNNING/STOPPED/ZOMBIE) | `ProcessState` + `AgentCondition[]` | L0 type, L1 state machine |
| `/proc/PID/status` | `agent-procfs` `/agents/<id>/descriptor` | L2 sidecar |
| `fork(2)` + `exec(2)` | `SpawnFn` | L0 contract → `@koi/execution-context` |
| `mqueue(7)` | `MailboxComponent` | L0 contract → `ipc-local` / `ipc-nexus` |
| Signals (SIGTERM/SIGSTOP) | `AGENT_SIGNALS` (STOP/CONT/TERM/USR1/USR2) | L0 → gateway → node → agent |
| `cgroups` | `GovernanceVariable` readings | Governance middleware |
| `capabilities(7)` | `DelegationGrant` | HMAC-signed, monotonically attenuated |
| `systemd` | `SupervisionController` | L1 `@koi/engine` |
| `/sys/` | Syscall table (7 contracts) | L0 |
| VFS | `FileSystemBackend` + Nexus Unified Namespace | Every domain concept is a path |
| netfilter/iptables | `KoiMiddleware` with phase typing | INTERCEPT / OBSERVE / RESOLVE |
| Device drivers | Engine adapters | L2 |
| Kernel modules | L2 feature packages | Independent, swappable |

</details>

## Development

```bash
git clone https://github.com/windoliver/koi.git
cd koi
bun install
bun run build
bun run test
```

### Prerequisites

- Bun 1.3.x
- If `bun install` fails at `lefthook install` because `core.hooksPath` is already set, run `lefthook install --force`

### Toolchain

| Tool | Choice |
|------|--------|
| Runtime | Bun 1.3.x |
| Package manager | `bun install` |
| Test runner | `bun:test` |
| Build | tsup (ESM-only, `.d.ts`) |
| Orchestration | Turborepo |
| Lint/Format | Biome |

### Building & testing

```bash
bun run build                             # full workspace build
bun test                                  # all tests
bunx turbo run test --filter=@koi/core    # single package
```

### CI gates

```bash
bun run typecheck         # strict TS compilation
bun run check             # Biome lint
bun run check:layers      # L0/L1/L2/L3 dependency enforcement
bun run check:doc-gate    # L2 package docs requirement
bun run check:complexity  # file/function size limits
bun run check:descriptions # package.json metadata
```

## Contributing

Contributions welcome. Please read the project's [`CLAUDE.md`](CLAUDE.md) for coding standards, architecture rules, and the anti-leak checklist before submitting PRs.

Key rules:
- `@koi/core` (L0) has zero runtime code — types and interfaces only
- L2 packages import from L0/L0u only — never from L1 or peer L2
- All interface properties are `readonly`
- No vendor types in L0 or L1
- PRs under 300 lines of logic changes
- 80% test coverage minimum

<details>
<summary><strong>v1 feature overview (archived)</strong></summary>

The v1 codebase (238 packages) included: 15 channel adapters, self-extending forge with 4-stage verification, time-travel debugging, cascade token routing, governed multi-agent delegation, Nexus unified namespace, MCP ecosystem integration, TUI, admin panel, and CLI (`koi init`, `koi up`, `koi start`, `koi serve`, `koi deploy`). See the `v1-archive` git tag or `archive/v1/` for the full source.

</details>

## License

Koi is source-available. See the repository for license details.
