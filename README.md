<p align="center">
  <img src="logo.svg" alt="Koi" width="200" />
</p>

<h1 align="center">Koi</h1>

<p align="center">
  <strong>The agent operating system.</strong><br/>
  Self-extending agents that are safe by design.
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> &middot;
  <a href="#presets">Presets</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#cli">CLI</a> &middot;
  <a href="#contributing">Contributing</a>
</p>

---

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

## Architecture

Koi uses a strict four-layer architecture. Layer violations are build errors.

```
L0  @koi/core        Interfaces-only kernel. Types + contracts. Zero logic. Zero deps.
L1  @koi/engine       Kernel runtime. Guards, lifecycle, middleware composition.
L2  @koi/*            Feature packages. Each depends on L0 only. Never on L1 or peers.
L3  Meta-packages     Convenience bundles (e.g., @koi/starter = L0 + L1 + selected L2).
```

### 7 contracts

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

### Key subsystems

| Subsystem | What it does |
|-----------|-------------|
| **Forge** | Safe self-extension: demand analysis, verification, crystallization, trust tiers |
| **Nexus** | Unified data layer — 14 connectors under a path API (everything is a file) |
| **Channels** | 15 I/O surfaces: CLI, Telegram, Slack, Discord, Voice, Email, AG-UI, and more |
| **Middleware** | 18 interposition modules: memory, retry, pay, PII, sandbox, permissions |
| **Engines** | 5 adapters: Pi (primary), Claude SDK, ReAct loop, external process, ACP |
| **Sandbox** | 11 backends: Docker, E2B, Wasm, Cloudflare Workers, and more |

## CLI

```
koi init [directory]     Create a new agent (interactive wizard)
koi up [manifest]        Start everything: runtime + admin + TUI (primary command)
koi start [manifest]     Start agent interactively (CLI channel only, no admin/TUI)
koi serve [manifest]     Run agent headless (for services)
koi admin [manifest]     Standalone admin panel server
koi demo <init|list|reset>  Manage demo data
koi deploy [manifest]    Install/uninstall OS service (launchd/systemd)
koi status [manifest]    Check service status
koi stop [manifest]      Stop the service
koi logs [manifest]      View service logs
koi doctor [manifest]    Diagnose service health
koi replay               Replay agent state at a specific turn
koi tui                  Interactive terminal console
```

### `koi init`

Interactive wizard that scaffolds a new agent project. Asks for preset, template, name, model, channels, and data sources.

```bash
koi init my-agent                                    # interactive wizard
koi init my-agent --preset demo --with telegram      # skip wizard steps
```

### `koi up`

The primary command. Starts the full runtime stack based on your manifest's preset.

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

## Development

```bash
git clone https://github.com/windoliver/koi.git
cd koi
bun install
bun run build:cli
```

### Running the CLI from this repo

The repo does not place a `koi` binary on your shell `PATH`. Use `bun run koi --`:

```bash
bun run koi -- init my-agent   # scaffold inside (or outside) the repo
cd my-agent
bun run up                     # starts everything
```

Inside the generated agent directory, `bun run` scripts are available:

```bash
bun run up            # koi up
bun run start:admin   # koi start --admin
bun run tui           # koi tui
bun run dry-run       # koi start --dry-run (validate config)
bun run doctor        # koi doctor
```

### Prerequisites

- Bun 1.3.x
- One model provider key (e.g., `ANTHROPIC_API_KEY`)
- If `bun install` fails at `lefthook install` because `core.hooksPath` is already set, run `lefthook install --force`

### Building the full workspace

```bash
bun run build      # all packages
bun run typecheck  # type checking
bun test           # all tests
```

## Toolchain

| Tool | Choice |
|------|--------|
| Runtime | Bun 1.3.x |
| Package manager | `bun install` |
| Test runner | `bun:test` |
| Build | tsup (ESM-only, `.d.ts`) |
| Orchestration | Turborepo |
| Lint/Format | Biome |

## Contributing

Contributions welcome. Please read `CLAUDE.md` for coding standards, architecture rules, and the anti-leak checklist before submitting PRs.

Key rules:
- `@koi/core` (L0) has zero runtime code — types and interfaces only
- L2 packages import from L0 only — never from L1 or peer L2
- All interface properties are `readonly`
- No vendor types in L0 or L1
- PRs under 300 lines of logic changes
- 80% test coverage minimum

## License

See [LICENSE](LICENSE) for details.
