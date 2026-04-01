<p align="center">
  <img src="logo.svg" alt="Koi" width="200" />
</p>

<h1 align="center">Koi</h1>

<p align="center">
  <strong>The self-evolving agent operating system.</strong><br/>
  Agents that run 24/7, forge their own tools, and rewrite their own harness — securely.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/TypeScript-Strict-blue?logo=typescript" alt="TypeScript Strict" />
  <img src="https://img.shields.io/badge/Runtime-Bun%201.3-f9f1e1?logo=bun" alt="Bun 1.3" />
<img src="https://img.shields.io/badge/PRs-Welcome-brightgreen" alt="PRs Welcome" />
</p>

<p align="center">
  <a href="#why-koi">Why Koi</a> &middot;
  <a href="#quickstart">Quickstart</a> &middot;
  <a href="#architecture">Architecture</a> &middot;
  <a href="#roadmap">Roadmap</a> &middot;
  <a href="docs/user-guide.md">Docs</a>
</p>

---

> **Status: Active development.** Koi's L0 contracts (types + interfaces) and architecture are stable. The v2 engine rewrite is in progress — see [Roadmap](#roadmap) for what's shipped vs. what's next. Not yet published to npm; build from source.

---

## Why Koi

### Self-Evolving <sup>v1 shipped, v2 in progress</sup>

Agents **forge new tools at runtime** when they hit a problem they can't solve. Every forged artifact passes 4-stage verification: static analysis → sandbox execution → adversarial probes → trust tier promotion. Learned patterns crystallize into reusable skills. Middleware stacks self-optimize. The agent you deploy on day 1 is not the agent running on day 30.

### Always-On <sup>v1 shipped, v2 Phase 3</sup>

Not request-response chatbots — **daemons**. Sleep/wake cycles, cron schedules, proactive PR monitoring, push alerts across any channel. Your agent watches GitHub overnight and briefs you on Telegram before you open your laptop.

### Secure by Architecture

Self-evolving agents without security is a nightmare. Koi treats security as a first-class architectural concern — not a bolt-on:

- **4-stage forge verification** — static analysis → sandbox execution → adversarial probes → trust tier promotion. Forged tools run isolated before they earn trust.
- **HMAC-signed delegation** — agents delegate to sub-agents with capability tokens that monotonically attenuate scope. A child can never exceed its parent.
- **21 security packages** — permissions, audit trails, budget enforcement, graduated sanctions, intent capsules, cascading revocation.
- **11 sandbox backends** — Docker, E2B, Wasm, Cloudflare Workers, Vercel, Daytona, OS sandbox.
- **Governed by contracts** — the kernel defines what agents can do. L0 contracts are the security boundary.

### Self-Harnessing <sup>v1 shipped, v2 Phase 3</sup>

The feedback loop that ties it together: run → encounter novel patterns → forge tools → verify → promote through trust tiers → crystallize into manifest → harness evolves. The agent doesn't just execute — it learns what to execute, builds the tools to do it, and rewires itself.

### 15 Channels <sup>v1 shipped, v2 Phase 3</sup>

CLI. Telegram. Slack. Discord. WhatsApp. Voice. Email. Signal. Teams. Matrix. Mobile. AG-UI. Chat SDK. Canvas. Web. One manifest, all of them.

### Everything is a File

SQL, REST, filesystem, agent memory — one path API. `nexus://agents/briefer/memory` and `nexus://sources/postgres/users` are the same query.

### Time Travel

Snapshot any agent. Rewind to a checkpoint, fork a timeline, replay from known-good state.

### Token Economics

Haiku → Sonnet → Opus cascade routing. Daily budgets, circuit breakers, kill switches. Cost tracked per tool call.

### MCP Compatible

Every MCP server from Claude Desktop, Cursor, or VS Code works in Koi. Two lines of YAML.

---

## Quickstart

```bash
git clone https://github.com/windoliver/koi.git && cd koi
bun install && bun run build:cli
```

```bash
bun run koi -- init my-agent    # interactive wizard
cd my-agent
bun run up                      # runtime + admin + TUI
```

`koi up` boots Nexus (data layer), agent runtime, admin panel at `localhost:3100/admin`, and TUI console.

### The manifest is the agent

```yaml
name: my-agent
model: "anthropic:claude-sonnet-4-5-20250514"
preset: demo
channels:
  - name: "@koi/channel-cli"
tools:
  koi:
    - name: "@koi/tool-ask-user"
    - name: "@koi/tools-web"
forge:
  enabled: true
schedule: "0 7 * * *"
autonomous:
  enabled: true
```

Add a channel, MCP server, or budget control — one line each:

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

---

## Architecture

Six layers, 245 packages. Layer violations are build errors.

```
L0   @koi/core           Contracts only. Zero logic. Zero deps.
L0u  47 utility pkgs     Pure functions. No business logic.
L1   @koi/engine         Kernel runtime. Lifecycle, guards, middleware.
L2   169 feature pkgs    Import L0/L0u only. Never L1 or peers.
L3   23 meta-packages    Wiring. The only place L1 + L2 meet.
L4   2 distribution pkgs Publishable bundles.
```

### 7 Contracts

| Contract | Purpose | Surface |
|----------|---------|---------|
| **Middleware** | Sole interposition for model + tool calls | 7 hooks |
| **Message** | Data format | `ContentBlock[]` |
| **Channel** | User I/O | `send()` + `onMessage()` |
| **Resolver** | Tool/skill/agent discovery | `discover()` + `load()` |
| **Assembly** | Agent definition | Declarative YAML |
| **Engine** | Swappable agent loop | `stream()` |
| **AgentRegistry** | Lifecycle management | CAS + `watch()` |

ECS composition: **Agent** = entity, **Tool** = component, **Middleware** = system.

<details>
<summary><strong>Subsystems</strong></summary>

| Domain | Pkgs | Highlights |
|--------|------|-----------|
| Middleware | 39 | Memory, retry, pay, PII, sandbox, permissions, circuit breakers |
| Channels | 15 | CLI to Voice to AG-UI |
| Forge | 11 | Demand analysis, verification, crystallization, trust tiers |
| Security | 21 | Delegation, audit, budget, graduated sanctions, intent capsules |
| Sandbox | 11 | Docker, E2B, Wasm, CF Workers, Vercel, Daytona |
| Memory | 16 | Hot/warm/cold, context editing, compaction |
| Observability | 12 | Dashboard, eval, tracing, real-time SSE |
| Multi-Agent | 9 | Gateway, federation, task board, handoff |
| Engines | 7 | Claude SDK, ReAct, ACP, browser, model router |

</details>

<details>
<summary><strong>Linux kernel mental model</strong></summary>

| Linux | Koi |
|-------|-----|
| `task_struct` | `ProcessDescriptor` |
| Process states | `ProcessState` + `AgentCondition[]` |
| `/proc/PID/status` | `agent-procfs` |
| `fork(2)` + `exec(2)` | `SpawnFn` |
| `capabilities(7)` | `DelegationGrant` (HMAC, monotonic) |
| `systemd` | `SupervisionController` |
| VFS | Nexus Unified Namespace |
| `netfilter` | `KoiMiddleware` (phase-typed) |

</details>

---

## CLI

| Command | Description |
|---------|-------------|
| `koi up` | Full stack — Nexus, runtime, admin, TUI |
| `koi init` | Scaffold new agent |
| `koi start` | CLI-only (lighter) |
| `koi serve` | Headless production mode |
| `koi deploy` | Install as OS service (launchd/systemd) |
| `koi tui` | Attach TUI |
| `koi replay` | Time-travel to any turn |
| `koi doctor` | Diagnose health |

---

## Roadmap

```
Phase 1 ████████░░░░░░░░  Core Engine
Phase 2 ░░░░░░░░░░░░░░░░  Agent Intelligence
Phase 3 ░░░░░░░░░░░░░░░░  Autonomous Infrastructure
Phase 4 ░░░░░░░░░░░░░░░░  Federation + Sensing
```

**Phase 1** — Query engine, tools, permissions, hooks, context management, API client.

- [ ] Single-turn text response
- [ ] Tool call → result → continuation
- [ ] Multi-tool concurrent + serial ordering
- [ ] Permission deny → model adjusts
- [ ] Permission ask → approval → execution
- [ ] Auto-compact on context overflow
- [ ] Time-decay microcompact
- [ ] Large result → disk + preview
- [ ] Abort signal propagation
- [ ] Hook lifecycle dispatch
- [ ] Token budget enforcement
- [ ] Loop detection → graceful stop

**Phase 2** — Sub-agents, coordinator, tasks, memory, dream extraction, skills.

**Phase 3** — Kairos proactive tools, daemon, Forge self-evolution, Nexus, Temporal, all 15 channels.

**Phase 4** — Multi-zone federation, sensor/embodied agents, cross-instance mobility.

---

## Development

```bash
git clone https://github.com/windoliver/koi.git && cd koi
bun install && bun run build:cli
bun test                                  # all tests
bunx turbo run test --filter=@koi/core    # single package
```

**Requires**: Bun 1.3.x + model provider key (e.g., `ANTHROPIC_API_KEY`).

---

## Contributing

Read [`CLAUDE.md`](CLAUDE.md) for architecture rules and coding standards. Every PR follows **Doc → Tests → Code → Refactor**. CI enforces layer checks, 80%+ coverage, and doc freshness.

---

<p align="center">
  <sub>Agents that sleep, wake, forge, evolve, and govern themselves — built on contracts, not guardrails.</sub>
</p>
