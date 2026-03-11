# Koi User Guide

This guide turns the monorepo into an operator manual. It is organized by use case, not by layer, and is intended to sit above the lower-level package docs in `docs/L2`, `docs/L3`, and `docs/L4`.

Coverage baseline for the current tree:

- 226 workspace packages across 17 families
- 226 packages with local test files
- 130 packages with dedicated package docs
- demo/use-case source: `demo-strategy.md`

Use [`package-coverage-map.md`](./package-coverage-map.md) as the package-by-package appendix.

## Read This First

The main entry points are:

- `koi` or `@koi/cli` for day-to-day operation
- `@koi/manifest` for the YAML contract
- `@koi/starter` for manifest-driven runtime assembly
- `@koi/engine` plus an engine adapter such as `@koi/engine-pi`
- `@koi/tui` for terminal operations against the admin API

The unpublished repo and the eventual packaged product expose the same subcommands. In the guide below, commands use the shipped CLI surface (`koi ...`). When working inside this repo before publication, invoke the same subcommands through the CLI source entrypoint instead.

## Use-Case Map

| Workflow | Primary surface | Core packages |
| --- | --- | --- |
| First run and local chat | `koi init`, `koi start` | `koi`, `@koi/cli`, `@koi/manifest`, `@koi/starter`, `@koi/channel-cli`, `@koi/engine`, `@koi/engine-pi` |
| Headless services and admin | `koi serve`, `koi admin` | `@koi/cli`, `@koi/deploy`, `@koi/dashboard-api`, `@koi/dashboard-ui`, `@koi/dashboard-types`, `@koi/nexus-embed` |
| Terminal operations | `koi tui` | `@koi/tui`, `@koi/channel-agui`, `@koi/agent-procfs`, `@koi/tracing`, `@koi/middleware-event-trace` |
| Tools, skills, and MCP | manifest `tools` + `skills` | `@koi/filesystem`, `@koi/tools-web`, `@koi/tools-github`, `@koi/tool-browser`, `@koi/tool-exec`, `@koi/skills`, `@koi/catalog`, `@koi/resolve`, `@koi/mcp`, `@koi/mcp-server` |
| Memory and long conversations | manifest `context` + memory middleware | `@koi/context`, `@koi/context-arena`, `@koi/middleware-hot-memory`, `@koi/middleware-conversation`, `@koi/transcript`, `@koi/session-store`, `@koi/session-repair` |
| Channels and external surfaces | manifest `channels` | `@koi/channel-*`, `@koi/gateway*`, `@koi/webhook-*`, `@koi/acp`, `@koi/acp-protocol`, `@koi/channel-canvas-fallback`, `@koi/channel-chat-sdk` |
| Governance and safe execution | manifest `middleware` + `forge` | `@koi/governance`, `@koi/middleware-*`, `@koi/exec-approvals`, `@koi/scope`, `@koi/delegation`, `@koi/sandbox*` |
| Multi-agent and swarm patterns | task spawn, workspace, federation | `@koi/task-spawn`, `@koi/handoff`, `@koi/ipc-*`, `@koi/workspace*`, `@koi/federation`, `@koi/agent-spawner`, `@koi/node-stack` |
| Browser, code, and engine selection | engine + sandbox choice | `@koi/engine-pi`, `@koi/engine-external`, `@koi/engine-acp`, `@koi/engine-loop`, `@koi/engine-claude`, `@koi/engine-rlm`, `@koi/model-router`, `@koi/browser-playwright`, `@koi/code-executor` |
| Self-extension and release gates | forge + eval + bundle | `@koi/forge`, `@koi/forge-*`, `@koi/crystallize`, `@koi/eval`, `@koi/self-test`, `@koi/doctor`, `@koi/bundle` |

## 1. First Contact

Use this path for the "YAML is the agent" experience from `demo-strategy.md` P1.

Typical flow:

```bash
koi init my-agent
cd my-agent
koi start
```

Core packages:

- `koi` for the single-package distribution
- `@koi/cli` for `init`, `start`, `serve`, `deploy`, `logs`, `doctor`, `tui`
- `@koi/manifest` for YAML loading, env interpolation, and validation
- `@koi/starter` for manifest-driven assembly
- `@koi/channel-cli` for the REPL channel
- `@koi/engine` and `@koi/engine-pi` for the runtime loop
- `@koi/bootstrap` and `@koi/soul` for bootstrap context and personality shaping

Author the manifest first. The main operator knobs are:

- `model` for the engine/model choice
- `channels` for how users talk to the agent
- `tools` for Koi-native and MCP tools
- `middleware` for safety, memory, retry, and quality behavior
- `context` for bootstrap text, memory lookups, and external sources
- `schedule`, `forge`, `deploy`, and `nexus` for production operation

Use `koi start --dry-run` before the first real run when changing manifest shape, model wiring, or environment variables.

## 2. Headless Services, Admin Panel, and TUI

This is the core operator workflow for demos P19 and E17.

There are three admin patterns:

1. `koi start --admin`
   This is the fastest local loop. It starts the interactive CLI plus the admin API on port `3100` by default.
2. `koi serve --admin`
   This runs the agent headlessly and serves health plus admin endpoints. By default the admin panel shares the service health port, which is `9100` unless overridden.
3. `koi admin`
   This starts the admin surface without starting a new agent. It can either run standalone or proxy to `koi serve --admin`. Its default port is `9200`.

The TUI talks to the admin API, not directly to the runtime:

```bash
koi serve --admin --port 9100
koi tui --url http://localhost:9100/admin/api
```

Important port pairing:

- `koi start --admin` pairs naturally with `koi tui` defaulting to `http://localhost:3100/admin/api`
- `koi serve --admin` should normally be paired with an explicit `--url`
- `koi admin --port 9200` should be paired with `koi tui --url http://localhost:9200/admin/api`

What the TUI currently supports:

- live agent list with refresh
- attach to a running agent
- AG-UI chat streaming
- session persistence under `/agents/{id}/session/tui/`
- recent lifecycle log tailing
- suspend, resume, and terminate commands
- session picker and command palette
- browser deep-links back into the admin panel

Useful TUI commands and shortcuts:

- `Ctrl+P` opens the command palette
- `Esc` leaves the active console session
- `q` quits
- `/attach <agentId>` jumps directly to an agent
- `/sessions`, `/logs`, `/health`, `/cancel`, `/agents` are wired through the console input

Packages worth knowing in this workflow:

- `@koi/tui`
- `@koi/dashboard-api`, `@koi/dashboard-ui`, `@koi/dashboard-types`
- `@koi/channel-agui`
- `@koi/agent-procfs`, `@koi/debug`, `@koi/tracing`, `@koi/middleware-event-trace`

## 3. Tools, Skills, Files, and MCP

This is the path for demos P2, P7, P8, P10, P15, and P18.

Think of the `fs` family as the working surface that lets agents inspect, edit, search, browse, and ask.

Use Koi-native tools when you need built-in behavior:

- `@koi/filesystem`, `@koi/code-mode`, `@koi/lsp`
- `@koi/tool-browser`, `@koi/tool-exec`
- `@koi/tools-web`, `@koi/tools-github`
- `@koi/tool-ask-user`, `@koi/tool-ask-guide`

Use the skill stack when you want packaged instructions or reusable workflows:

- `@koi/skills`
- `@koi/skill-scanner`
- `@koi/catalog`
- `@koi/resolve`
- `@koi/registry-*` and `@koi/store-*`

Use MCP and ACP when Koi needs to interoperate with outside tool or IDE ecosystems:

- `@koi/mcp` as a client
- `@koi/mcp-server` when Koi acts as a server
- `@koi/acp` and `@koi/acp-protocol` for IDE agent flows

The important operator detail is that `@koi/catalog` and `@koi/resolve` are the glue between manifest descriptors and live tool/skill instances. They deserve explicit attention when a manifest looks valid but the runtime is missing tools.

## 4. Memory, Context, and Conversation Continuity

This is the path for demos P14, P15, and the long-lived assistant scenarios behind P20.

There are four distinct context layers:

1. bootstrap context from `@koi/bootstrap`, `@koi/context`, and `@koi/soul`
2. hot session memory from `@koi/middleware-hot-memory`
3. conversation continuity from `@koi/middleware-conversation`, `@koi/transcript`, and `@koi/session-store`
4. long-session hygiene from `@koi/middleware-compactor`, `@koi/middleware-context-editing`, `@koi/tool-squash`, and `@koi/token-estimator`

Packages to keep together in this workflow:

- `@koi/context`, `@koi/context-arena`
- `@koi/memory-fs`
- `@koi/middleware-hot-memory`
- `@koi/middleware-ace`, `@koi/middleware-collective-memory`, `@koi/middleware-user-model`
- `@koi/middleware-conversation`
- `@koi/session-store`, `@koi/session-repair`
- `@koi/transcript`
- `@koi/snapshot-chain-store`, `@koi/snapshot-store-sqlite`

If the agent feels forgetful, repetitive, or starts dropping crucial details after long runs, debug this layer before assuming the model is the problem.

## 5. Channels, Gateways, and External Surfaces

This covers demos P4, P9, E1, E17, and all service-oriented deployments.

Use channels when the agent must receive or send messages on a user-facing surface:

- terminal: `@koi/channel-cli`
- chat apps: `@koi/channel-slack`, `@koi/channel-discord`, `@koi/channel-telegram`, `@koi/channel-teams`, `@koi/channel-matrix`, `@koi/channel-signal`, `@koi/channel-whatsapp`
- rich and embedded UIs: `@koi/channel-agui`, `@koi/channel-chat-sdk`, `@koi/channel-canvas-fallback`
- voice/mobile/email: `@koi/channel-voice`, `@koi/channel-mobile`, `@koi/channel-email`

Use gateway and webhook packages when the agent must sit behind HTTP or bridge to rich UI surfaces:

- `@koi/gateway`, `@koi/gateway-types`
- `@koi/gateway-webhook`, `@koi/webhook-provider`, `@koi/webhook-delivery`
- `@koi/canvas`, `@koi/gateway-canvas`, `@koi/channel-canvas-fallback`
- `@koi/gateway-nexus`

Use `@koi/channel-canvas-fallback`, `@koi/channel-agui`, `@koi/canvas`, and `@koi/gateway-canvas` together when the same agent must render richer output on capable clients while remaining usable on text-only channels.

## 6. Governance, Safety, and Safe Execution

This is the main path for demos P3, P6, P7b, E5, E6, E7, E9, and E11.

Koi's security model is mostly middleware plus supporting backends.

Human approval and policy:

- `@koi/middleware-permissions`
- `@koi/exec-approvals`
- `@koi/permissions-nexus`
- `@koi/middleware-governance-backend`
- `@koi/scope`

Audit, payments, and compliance:

- `@koi/middleware-audit`
- `@koi/audit-sink-local`
- `@koi/audit-sink-nexus`
- `@koi/middleware-pay`
- `@koi/pay-local`, `@koi/pay-nexus`

Data protection and content safety:

- `@koi/middleware-pii`
- `@koi/middleware-sanitize`
- `@koi/redaction`
- `@koi/middleware-guardrails`

Execution containment and recovery:

- `@koi/middleware-sandbox`
- `@koi/middleware-fs-rollback`
- `@koi/middleware-tool-audit`
- `@koi/middleware-call-dedup`
- `@koi/middleware-call-limits`
- `@koi/middleware-tool-selector`
- `@koi/middleware-tool-recovery`

Enterprise oversight and delegation:

- `@koi/delegation`
- `@koi/capability-verifier`
- `@koi/middleware-delegation-escalation`
- `@koi/middleware-intent-capsule`
- `@koi/governance-memory`
- `@koi/security-analyzer`
- `@koi/collusion-detector`
- `@koi/reputation`

Use `koi doctor` before rollout when you want a fast preflight over manifest health, governance assumptions, and deployment readiness.

## 7. Multi-Agent, Workspaces, and Distributed Operation

This covers demos P12, P13b, E3, E4, E10, E12, and E13.

The swarm pattern is built from a few specific clusters:

- delegation and artifact passing: `@koi/task-spawn`, `@koi/handoff`
- messaging and shared state: `@koi/ipc-local`, `@koi/ipc-nexus`, `@koi/scratchpad-local`, `@koi/scratchpad-nexus`
- isolated workspaces: `@koi/workspace`, `@koi/workspace-nexus`
- distributed routing and discovery: `@koi/federation`, `@koi/name-service`, `@koi/name-service-nexus`
- orchestration packages: `@koi/agent-spawner`, `@koi/autonomous`, `@koi/node-stack`, `@koi/goal-stack`, `@koi/workspace-stack`

When you want the "manager mode" or "agent company" story, document these together. The important operational promise is not just message passing. It is isolated work, shared artifacts, resumable coordination, and safe delegation.

## 8. Engines, Browser Automation, Sandboxes, and Routing

This covers demos P10, P16, P18, E14, and resilience-focused production runs.

Use `@koi/engine-pi` by default for normal multi-turn Koi agents.

Pick a different engine when the problem changes:

- `@koi/engine-external` for CLI agents and coding-agent delegation over PTY or long-lived subprocesses
- `@koi/engine-acp` for ACP-speaking agents
- `@koi/engine-claude` for Claude Agent SDK integration
- `@koi/engine-loop` for simple deterministic tool loops
- `@koi/engine-rlm` when inputs are larger than the model context window
- `@koi/model-router` when you want routing, fallback, cascade, or circuit breaking across models/providers

Browser and code execution stack:

- `@koi/browser-playwright`
- `@koi/code-executor`
- `@koi/sandbox`, `@koi/sandbox-docker`, `@koi/sandbox-wasm`
- `@koi/sandbox-e2b`, `@koi/sandbox-vercel`, `@koi/sandbox-daytona`, `@koi/sandbox-cloudflare`
- `@koi/sandbox-executor`, `@koi/sandbox-ipc`, `@koi/sandbox-cloud-base`

This section is worth treating as an explicit backend matrix in demos and operator playbooks: local secure default, remote burst capacity, browser automation, and forge verification each have different tradeoffs.

## 9. Self-Extension, Evaluation, and Release Gates

This covers demos P3, P16, P17, E15, E16, E19, and E20.

Forge packages are the safe self-extension subsystem:

- `@koi/forge`
- `@koi/forge-demand`
- `@koi/crystallize`
- `@koi/forge-verifier`
- `@koi/forge-integrity`
- `@koi/forge-policy`
- `@koi/forge-optimizer`
- `@koi/forge-exaptation`
- `@koi/forge-tools`, `@koi/forge-types`

Operationally, the loop is:

1. detect demand for a missing or weak capability
2. build or crystallize an artifact
3. verify it in sandboxed and adversarial conditions
4. assign or downgrade trust
5. publish, re-use, or reject

Release and quality packages to pair with forge:

- `@koi/eval`
- `@koi/self-test`
- `@koi/quality-gate`
- `@koi/verified-loop`
- `@koi/bundle`
- `@koi/doctor`

If you are demonstrating "safe self-extending agents," do not stop at artifact generation. Show verification, trust-tier assignment, and operator-visible auditability.

## 10. Local, Durable, and Distributed Production

This is the path for demos P19, P20, E3, E12, E13, E17, E18, and E20.

Local and embedded operation:

- `@koi/nexus-embed`
- `@koi/deploy`
- `@koi/bundle`

Durable and scheduled operation:

- `@koi/scheduler`
- `@koi/scheduler-provider`
- `@koi/scheduler-nexus`
- `@koi/long-running`
- `@koi/harness-scheduler`
- `@koi/temporal`

Distributed or multi-node operation:

- `@koi/node`
- `@koi/node-stack`
- `@koi/federation`
- `@koi/gateway-nexus`

Use this separation in docs and demos:

- local dev: `koi start`, `koi serve`, `nexus-embed`
- operator console: dashboard plus `koi tui`
- durable services: scheduler, checkpointing, Temporal
- multi-node: node stack, federation, Nexus-backed coordination

## 11. Where To Go Deeper

- package docs: `docs/L2`, `docs/L3`, `docs/L4`
- architecture docs: `docs/architecture`
- runtime details: `docs/engine`
- workspace and service-provider patterns: `docs/workspace.md`, `docs/service-provider.md`
- package inventory: [`package-coverage-map.md`](./package-coverage-map.md)

If you only need one starting sequence, use this:

1. `koi init`
2. `koi start --admin`
3. `koi tui`
4. add channels, tools, middleware, and memory in the manifest
5. move to `koi serve --admin` once the workflow is stable
