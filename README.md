<p align="center">
  <img src="logo.svg" alt="Koi" width="200" />
</p>

<h1 align="center">Koi</h1>

<p align="center">
  <strong>The self-extending agent operating system.</strong><br/>
  238 packages. 7 contracts. One YAML file.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-Strict-blue?logo=typescript" alt="TypeScript Strict" />
  <img src="https://img.shields.io/badge/Runtime-Bun%201.3-f9f1e1?logo=bun" alt="Bun 1.3" />
  <img src="https://img.shields.io/badge/PRs-Welcome-brightgreen" alt="PRs Welcome" />
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> &middot;
  <a href="#presets">Presets</a> &middot;
  <a href="#what-makes-koi-different">Why Koi</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#cli">CLI</a> &middot;
  <a href="docs/user-guide.md">Docs</a> &middot;
  <a href="#contributing">Contributing</a>
</p>

---

> **Koi is an agent operating system, not another agent framework.** Agents forge their own tools at runtime — with 4-stage verification so they can't go rogue. Talk to them across 15 channels, from CLI to Telegram to Voice to AG-UI. Rewind any agent to any checkpoint with time-travel debugging. Route tokens through Haiku → Sonnet → Opus cascade routing to cut costs 10×. Govern multi-agent delegation with HMAC-signed, scope-attenuated tokens. And query every data source — SQL, REST, filesystem — through a single path API where everything is a file.

## Quickstart

> **Pre-release**: Koi is not yet published to npm. Build from source — see [Development](#development).

```bash
git clone https://github.com/windoliver/koi.git
cd koi
bun install
bun run build:cli
```

Create and run an agent:

```bash
bun run koi -- init my-agent      # interactive wizard (pick a preset)
cd my-agent
bun run up                        # starts runtime + admin panel + TUI
```

The wizard asks you to pick a **preset** (local, demo, or mesh), a model, and optional channels. It generates a `koi.yaml` manifest, `.env` file, and everything needed to run.

### What `koi up` starts

`koi up` is the primary entry point. It orchestrates everything in one command:

- Agent runtime on your configured model
- Admin panel at `http://localhost:3100/admin`
- Embedded Nexus (data layer) in local mode
- TUI operator console (demo/mesh presets)
- Health endpoint at `http://localhost:9100/health`
- Demo data seeding (demo preset: 530 employees, 120 customers, 30 products)

### The manifest is the agent

```yaml
# koi.yaml
name: my-agent
version: 0.1.0
description: My first Koi agent
model: "anthropic:claude-sonnet-4-5-20250514"
preset: demo

channels:
  - name: "@koi/channel-cli"

tools:
  koi:
    - name: "@koi/tool-ask-user"
    - name: "@koi/tools-web"
    - name: "@koi/tool-exec"

forge:
  enabled: true

autonomous:
  enabled: true

demo:
  pack: connected

context:
  bootstrap: true
```

Add a channel? One line. Add an MCP server? Two lines. Add budget controls? Three lines.

```yaml
channels:
  - "@koi/channel-telegram": { token: ${TELEGRAM_BOT_TOKEN} }
tools:
  mcp:
    - name: yahoo-finance
      command: "npx yahoo-finance-mcp"
middleware:
  - "@koi/middleware-pay": { budget: { daily: 0.50 } }
```

## Presets

The `koi init` wizard lets you pick a preset that controls how much infrastructure `koi up` starts:

| Preset | What you get | Best for |
|--------|-------------|----------|
| **local** | CLI agent + Nexus (no auth). Minimal. | Learning, quick tests |
| **demo** | Full experience: TUI, admin panel, forge, autonomous mode, demo data (HERB enterprise dataset), auto-provisioned helper agents | First-time demo, showing Koi's capabilities |
| **mesh** | Everything in demo + gateway + multi-agent node + governance | Multi-agent orchestration |

### Demo preset details

The demo preset auto-seeds a fictional enterprise (HERB) into Nexus with:
- 530 employees, 120 customers, 30 products, 20 Q&A pairs
- Pre-computed forge brick views for the dashboard
- A `research-helper` agent alongside your primary agent
- Soul personality file at `.koi/SOUL.md`

Start chatting immediately — try "What did I learn?" or "Show me data."

## What Makes Koi Different

### Forge — Self-Extension with Verification

Agents create their own tools, skills, and sub-agents at runtime. Every forged artifact passes 4-stage verification: static analysis, sandbox execution, adversarial probes, and trust tier promotion. No other framework lets agents grow their own capabilities *and* keeps them safe.

```yaml
forge:
  enabled: true
  maxForgesPerSession: 5
```

### 15 Channels — Meet Users Where They Are

CLI, Telegram, Slack, Discord, WhatsApp, Voice, Email, Signal, Teams, Matrix, Mobile, AG-UI, Chat SDK, Canvas, Web. Same agent, same manifest — just add a line.

```yaml
channels:
  - name: "@koi/channel-cli"
  - "@koi/channel-telegram": { token: ${TELEGRAM_BOT_TOKEN} }
  - "@koi/channel-slack": { token: ${SLACK_BOT_TOKEN} }
```

### Time Travel — Rewind, Fork, Replay

Snapshot any agent at any point. Rewind to a previous checkpoint, fork a new timeline, or replay from a known-good state. Built on an immutable snapshot chain with content-addressed storage.

### Token Economics — Cascade Routing

Route requests through Haiku → Sonnet → Opus based on complexity. Set daily budgets, circuit breakers, and kill switches. Pay-per-tool metering tracks cost to the individual tool call.

```yaml
middleware:
  - "@koi/middleware-pay": { budget: { daily: 0.50 } }
  - "@koi/middleware-circuit-breaker": { threshold: 5, window: 60 }
```

### Governed Delegation — Multi-Agent Trust

Agents delegate to sub-agents with HMAC-signed tokens that monotonically attenuate scope. A child agent can never have more permissions than its parent. Cascading revocation kills an entire delegation tree in one call.

```yaml
middleware:
  - "@koi/middleware-permissions": { default: ask }
  - "@koi/middleware-delegation-escalation": {}
```

### Everything is a File — Nexus Unified Namespace

SQL databases, REST APIs, local files, agent memory — all accessible through a single path API. Query `nexus://agents/briefer/memory/preferences` the same way you query `nexus://sources/postgres/users`. Auto-starts in embed mode (SQLite + filesystem) or connects to a shared Nexus server.

```yaml
nexus:
  url: https://nexus.example.com
context:
  sources:
    - kind: memory
      query: "user preferences"
```

### MCP Ecosystem — Plug and Play

Any MCP server works as a tool. The same servers that work in Claude Desktop, Cursor, and VS Code work in Koi — declared in two lines of YAML.

```yaml
tools:
  mcp:
    - name: yahoo-finance
      command: "npx yahoo-finance-mcp"
    - name: playwright
      command: "npx @anthropic/mcp-server-playwright"
```

## Architecture

Koi uses a strict five-layer architecture. Layer violations are build errors.

```
L0  @koi/core        Interfaces-only kernel. Types + contracts. Zero logic. Zero deps.
L0u 44 utility pkgs   Pure functions — errors, validation, hashing, manifests. Zero business logic.
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

### Key Subsystems

| Subsystem | Packages | What it does |
|-----------|----------|-------------|
| **Middleware** | 39 | Interposition for memory, retry, pay, PII, sandbox, permissions, circuit breakers, and more |
| **Channels** | 15 | Every surface from CLI to Voice to AG-UI |
| **Forge** | 11 | Safe self-extension: demand analysis, verification, crystallization, trust tiers |
| **Security** | 21 | Permissions, audit, budget, delegation, graduated sanctions, intent capsules |
| **Sandbox** | 11 | Docker, E2B, Wasm, Cloudflare Workers, Vercel, Daytona, OS sandbox, and more |
| **Memory** | 16 | Hot/warm/cold memory, context editing, conversation, user modeling, compaction |
| **Observability** | 12 | Dashboard, eval, tracing, monitoring, debug — real-time admin panel with SSE |
| **IPC** | 9 | Gateway, Node, mDNS, task board, agent spawner, federation |
| **Engines** | 7 | Pi (primary), Claude SDK, ReAct loop, external process, ACP, browser, model router |

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

## Manifest

The `koi.yaml` manifest defines everything about an agent declaratively — YAML is the agent.

```yaml
name: daily-briefer
version: 0.1.0
model: "anthropic:claude-haiku-4-5-20251001"

# Nexus: auto-starts locally in embed mode (SQLite + filesystem).
# Set nexus.url for remote/shared Nexus.
# nexus:
#   url: https://nexus.example.com

channels:
  - name: "@koi/channel-cli"
  - "@koi/channel-telegram": { token: ${TELEGRAM_BOT_TOKEN} }

tools:
  koi:
    - name: "@koi/tools-web"
    - name: "@koi/tool-ask-user"
  mcp:
    - name: reddit
      command: "npx reddit-mcp-server"

middleware:
  - "@koi/middleware-hot-memory": {}
  - "@koi/middleware-pay": { budget: { daily: 0.50 } }
  - "@koi/middleware-permissions": { default: ask }

forge:
  enabled: true
  maxForgesPerSession: 5

schedule: "0 7 * * *"

soul: "./soul.md"

context:
  bootstrap: true
  sources:
    - kind: text
      text: "You are a concise personal assistant."
    - kind: memory
      query: "user preferences"
```

## CLI

| Command | Description |
|---------|-------------|
| `koi up` | Start full stack — runtime, admin, TUI (recommended) |
| `koi init [dir]` | Scaffold a new agent project (interactive wizard) |
| `koi start [manifest]` | Start agent interactively (CLI only, no admin/TUI) |
| `koi serve [manifest]` | Run agent headless (for services) |
| `koi admin [manifest]` | Run standalone admin panel |
| `koi demo <init\|list\|reset>` | Manage demo data |
| `koi deploy [manifest]` | Install as OS service (launchd/systemd) |
| `koi status [manifest]` | Check service status |
| `koi stop [manifest]` | Stop the service |
| `koi logs [manifest]` | View service logs |
| `koi doctor [manifest]` | Diagnose service health |
| `koi replay` | Replay agent state at a specific turn |
| `koi tui` | Interactive terminal console |

### `koi init`

Interactive wizard that scaffolds a new agent project. Asks for preset, template, name, model, channels, and data sources.

```bash
koi init my-agent                                    # interactive wizard
koi init my-agent --preset demo --with telegram      # skip wizard steps
```

### `koi up`

The primary command. Boots the full stack in one command — Nexus, primary agent, provisioned agents, channels, admin panel, and TUI.

```bash
koi up                    # uses ./koi.yaml
koi up --detach           # run in background
```

### `koi start`

Lighter alternative — CLI channel only, no admin panel or TUI. Good for quick testing.

```bash
koi start                     # uses ./koi.yaml
koi start --admin             # add admin panel
koi start --admin --verbose   # with debug logging
```

### `koi serve`

Headless mode for production services. HTTP health server, graceful shutdown, conversation persistence.

```bash
koi serve --port 9100 --nexus-url https://nexus.example.com
```

### `koi deploy`

Install as a background OS service with automatic restart.

```bash
koi deploy                     # user service (launchd on macOS, systemd on Linux)
koi deploy --system            # system-wide service
koi deploy --uninstall         # remove the service
```

## Admin Panel

A browser-based UI for managing running agents, built on React 19 + Vite. Wired into the CLI via `koi up`, `koi start --admin`, `koi serve --admin`, `koi admin`, and `koi tui`.

**Core views:**
- Agent status, tool inventory, cost tracking, audit log
- Nexus file browser (everything-is-a-file namespace tree)
- Real-time SSE event stream
- Runtime views: process tree, middleware chain, gateway topology
- Commands: suspend, resume, terminate agents; retry dead-letter queue

<details>
<summary><strong>Planned features</strong></summary>

- **Orchestration overlay** ([#924](https://github.com/windoliver/koi/issues/924)): Temporal workflows, scheduler kanban, task board DAG, harness checkpoints
- **Interactive console** ([#933](https://github.com/windoliver/koi/issues/933)): Create/dispatch agents from the browser, chat via AG-UI streaming

</details>

## Development

```bash
git clone https://github.com/windoliver/koi.git
cd koi
bun install
bun run build:cli
```

### Running with `koi up`

The repo does not place a `koi` binary on your shell `PATH`. Use `bun run koi --`:

```bash
bun run koi -- init my-agent   # scaffold inside (or outside) the repo
cd my-agent
bun run up                     # starts everything
```

Inside the generated agent directory, `bun run` scripts are available:

```bash
bun run up            # koi up — runtime + admin + TUI
bun run dry-run       # validate manifest without starting
bun run start:admin   # koi start --admin
bun run tui           # attach TUI to running admin API
bun run doctor        # diagnose health
```

### Prerequisites

- Bun 1.3.x
- One model provider key (e.g., `ANTHROPIC_API_KEY`)
- If `bun install` fails at `lefthook install` because `core.hooksPath` is already set, run `lefthook install --force`
- Local Nexus embed mode is the default when no URL is set

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

## Contributing

Contributions welcome. Please read the project's [`CLAUDE.md`](CLAUDE.md) for coding standards, architecture rules, and the anti-leak checklist before submitting PRs.

Key rules:
- `@koi/core` (L0) has zero runtime code — types and interfaces only
- L2 packages import from L0/L0u only — never from L1 or peer L2
- All interface properties are `readonly`
- No vendor types in L0 or L1
- PRs under 300 lines of logic changes
- 80% test coverage minimum

## Package Landscape

238 packages across 19 categories:

| Category | Count | Examples |
|----------|------:|---------|
| **Network & Channels** | 30 | 15 channel adapters, gateway, MCP bridge, webhooks, ACP |
| **Filesystem & Storage** | 29 | Nexus stores, registries (memory/SQLite/HTTP/Nexus), skills, tools, search |
| **Utilities** | 26 | errors, validation, crypto, hashing, event delivery, test utils |
| **Middleware** | 22 | call limits, circuit breaker, sandbox, semantic retry, tool audit, turn ack |
| **Meta-packages** | 22 | CLI, starter, autonomous, governance, forge, stacks (gateway, retry, sandbox, ...) |
| **Security** | 21 | audit sinks, delegation, permissions, PII redaction, guardrails, intent capsules |
| **Memory** | 16 | hot/warm/cold memory, context editing, compaction, user model, session repair |
| **Observability** | 12 | dashboard (API + UI + types), eval, tracing, agent-procfs, self-test |
| **Forge** | 11 | demand analysis, verification, crystallization, exaptation, optimizer, policy |
| **Sandbox** | 11 | Docker, E2B, Wasm, Cloudflare, Vercel, Daytona, IPC, cloud-base |
| **IPC** | 9 | federation, handoff, local/Nexus IPC, scratchpads, task spawn, workspaces |
| **Kernel** | 8 | core (L0), engine (L1), engine-compose, engine-reconcile, manifest, bootstrap |
| **Drivers** | 7 | engine-pi, engine-claude, engine-loop, engine-acp, engine-external, model-router |
| **Scheduler** | 6 | harness scheduler, long-running, Nexus scheduler, verified loop |
| **Deploy** | 4 | bundle, deploy (launchd/systemd), nexus-embed, node |
| **Data Sources** | 2 | connector-forge, discovery |
| **Exec** | 1 | Temporal orchestration |
| **UI** | 1 | TUI (terminal interface) |

## License

Koi is source-available. See the repository for license details.
