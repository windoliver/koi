# Koi Test Plan

This plan is organized around the same use cases as `docs/user-guide.md`, then tied back to package families and current suites. It is intended to guide both incremental package work and full-system regression gates.

Coverage baseline for the current tree:

- 226 workspace packages across 17 families
- every package currently contains local test files
- package-family appendix: [`package-coverage-map.md`](./package-coverage-map.md)
- current end-to-end suite location: `tests/e2e`

## Test Strategy

Use five layers of tests together:

1. Contract tests
   For L0 and L0u interfaces, protocol envelopes, storage backends, and reusable helpers.
2. Package tests
   For parsing, state machines, adapters, reducers, and middleware behavior in isolation.
3. Integration tests
   For manifest resolution, stack composition, backend selection, admin surfaces, and runtime lifecycle.
4. End-to-end operator tests
   For CLI, admin panel, TUI, channels, Nexus, browser, delegation, and forge.
5. Soak, chaos, and adversarial tests
   For reconnects, restarts, policy outages, sandbox failures, corruption, and long-running sessions.

The key rule is that Koi should be tested by workflow, not only by package. Many of the highest-risk failures live at package boundaries.

## Priority Scenarios

The highest-value scenario bundles are:

- local operator workflow: `@koi/cli` + `@koi/engine-pi` + `@koi/channel-cli` + admin panel + `@koi/tui`
- manifest-driven production agent: `@koi/manifest` + `@koi/starter` + `@koi/nexus` + governance stack
- skill and tool runtime: `@koi/catalog` + `@koi/resolve` + filesystem/tools + `@koi/mcp`
- long-running assistant: context arena + memory + transcript + session repair + compaction
- governed execution: permissions + approvals + audit + pay + sandbox + rollback
- swarm/delegation: task spawn + handoff + IPC + workspace + federation
- browser and code automation: Playwright + sandbox backends + tracing + recovery middleware
- safe self-extension: forge demand + verifier + integrity + policy + eval + bundle

## 1. Boot, Manifest, and Runtime Assembly

Packages:

- `@koi/manifest`, `@koi/bootstrap`, `@koi/soul`, `@koi/config`
- `@koi/starter`, `@koi/engine`, `@koi/engine-compose`, `@koi/engine-reconcile`
- `koi`

Required coverage:

- manifest env interpolation, shorthand expansion, schema validation, warnings
- bootstrap file precedence and missing-file fallback
- runtime assembly from manifest descriptors into concrete middleware, tools, channels, and backends
- middleware order, capability injection, session hooks, delivery policy, and supervision transitions
- single-package export correctness for `koi` root and subpaths

Failure injection:

- invalid YAML
- missing env vars
- unknown package names and alias mismatches
- bad callback wiring in starter stacks
- supervision restart loops and termination cascades

Current suites already aligned with this area:

- `tests/e2e/manifest-resolve-e2e.test.ts`
- `tests/e2e/context-env.e2e.test.ts`
- `tests/e2e/e2e-contracts.test.ts`
- `tests/e2e/pi-agent.test.ts`

## 2. CLI, Admin Panel, and TUI Operations

Packages:

- `@koi/cli`, `@koi/tui`
- `@koi/dashboard-api`, `@koi/dashboard-ui`, `@koi/dashboard-types`
- `@koi/agent-procfs`, `@koi/debug`, `@koi/tracing`, `@koi/middleware-event-trace`
- `@koi/deploy`, `@koi/shutdown`

Required coverage:

- `koi init`, `start`, `serve`, `admin`, `deploy`, `status`, `stop`, `logs`, `doctor`, `tui`
- admin enablement on `koi start --admin` and `koi serve --admin`
- port behavior for `start`, `serve`, and `admin`
- TUI attach/chat/session/logs/suspend/resume/terminate paths
- AG-UI stream handling, SSE reconnect, `Last-Event-ID`, and store transitions
- procfs and dashboard state reflecting the same live agent facts

Failure injection:

- unauthorized admin API
- dropped SSE stream
- stale session log or missing TUI history
- health endpoint up but admin API unavailable
- TTY-less environment or raw-mode failure for the TUI

Current suites already aligned with this area:

- `packages/meta/cli/src/commands/*`
- `packages/ui/tui/src/**/*.test.ts`
- `packages/observability/dashboard-api/src/__tests__/handler.integration.test.ts`
- `packages/observability/dashboard-api/src/__tests__/e2e-real-agent.test.ts`

Gap to add explicitly:

- a true CLI-to-TUI operator e2e that starts an admin-enabled agent, connects `koi tui`, sends a message, resumes a saved session, and validates persisted chat log shape

## 3. Tools, Skills, Filesystem, Search, and MCP

Packages:

- `@koi/catalog`, `@koi/resolve`
- `@koi/filesystem`, `@koi/code-mode`, `@koi/lsp`
- `@koi/tool-browser`, `@koi/tool-exec`, `@koi/tools-web`, `@koi/tools-github`, `@koi/tool-ask-user`, `@koi/tool-ask-guide`
- `@koi/skills`, `@koi/skill-scanner`
- `@koi/search`, `@koi/search-provider`, `@koi/search-brave`, `@koi/search-nexus`
- `@koi/mcp`, `@koi/mcp-server`, `@koi/acp`, `@koi/acp-protocol`

Required coverage:

- manifest-to-runtime resolution of tools and skills
- registry/store/provider compatibility across memory, file, SQLite, HTTP, and Nexus variants
- tool execution, serialization, and trust-tier behavior
- skill scanning and hot loading
- MCP client/server interoperability
- ACP protocol framing and IDE-facing flows

Failure injection:

- malformed skill manifests
- tool result parse failures
- dead MCP subprocesses
- catalog/registry mismatch between descriptor and stored artifact
- mixed local and Nexus resolution

Current suites already aligned with this area:

- `tests/e2e/browser-skill.e2e.test.ts`
- `tests/e2e/fs-skill.e2e.test.ts`
- `tests/e2e/skill-registry.test.ts`
- `tests/e2e/skill-stack.e2e.test.ts`
- `tests/e2e/capability-registry-e2e.test.ts`

Gap to add explicitly:

- one "manifest declares Koi-native tools + skill + MCP server" end-to-end that verifies discovery, execution, and operator-visible audit trail together

## 4. Memory, Context, Transcript, and Session Repair

Packages:

- `@koi/context`, `@koi/context-arena`, `@koi/memory-fs`
- `@koi/middleware-hot-memory`, `@koi/middleware-ace`, `@koi/middleware-collective-memory`, `@koi/middleware-user-model`
- `@koi/middleware-conversation`, `@koi/transcript`
- `@koi/session-store`, `@koi/session-repair`
- `@koi/middleware-compactor`, `@koi/middleware-context-editing`, `@koi/tool-squash`, `@koi/token-estimator`
- `@koi/snapshot-chain-store`, `@koi/snapshot-store-sqlite`

Required coverage:

- conversation continuity across turns, restarts, and resumed sessions
- long-context compaction without losing the current task
- transcript fidelity for user, assistant, tool, and lifecycle entries
- session repair under truncated or partially corrupted histories
- memory injection limits and prioritization

Failure injection:

- interrupted writes
- corrupted transcript records
- replaying old snapshots into new sessions
- token budget exhaustion
- compaction occurring during tool-heavy conversations

Current suites already aligned with this area:

- `tests/e2e/context-env.e2e.test.ts`
- `tests/e2e/pi-agent.test.ts`

Gap to add explicitly:

- a restart-and-repair scenario using transcript + session store + session repair + compactor on a long multi-turn conversation

## 5. Channels, Gateways, and Content Transformation Parity

Packages:

- all `@koi/channel-*` packages
- `@koi/gateway`, `@koi/gateway-types`, `@koi/gateway-webhook`, `@koi/gateway-canvas`, `@koi/gateway-nexus`
- `@koi/webhook-provider`, `@koi/webhook-delivery`
- `@koi/canvas`

Required coverage:

- text round-trips, thread identity, and sender identity across channels
- structured content mapping for markdown, files, tool results, and rich surfaces
- channel health and reconnect logic
- canvas-to-text fallback behavior
- AG-UI and Chat SDK parity for streaming events
- voice-specific lifecycle where content transforms rather than simply transports

Failure injection:

- disconnect/reconnect in the middle of a streamed turn
- out-of-order delivery
- malformed webhook payloads
- channel-specific limits such as unsupported content or missing thread IDs

Current suites already aligned with this area:

- `tests/e2e/e2e-canvas.test.ts`
- `tests/e2e/e2e-canvas-fallback.test.ts`

Gap to add explicitly:

- a common conformance harness that can be run against every channel adapter for identity, threading, error reporting, and content-block parity

## 6. Governance, Approvals, Audit, and Safe Execution

Packages:

- `@koi/governance`
- `@koi/middleware-permissions`, `@koi/exec-approvals`, `@koi/permissions-nexus`
- `@koi/middleware-audit`, `@koi/audit-sink-local`, `@koi/audit-sink-nexus`
- `@koi/middleware-pay`, `@koi/pay-local`, `@koi/pay-nexus`
- `@koi/middleware-pii`, `@koi/middleware-sanitize`, `@koi/redaction`, `@koi/middleware-guardrails`
- `@koi/middleware-sandbox`, `@koi/middleware-fs-rollback`, `@koi/middleware-tool-audit`, `@koi/middleware-call-dedup`, `@koi/middleware-call-limits`, `@koi/middleware-tool-selector`, `@koi/middleware-tool-recovery`
- `@koi/delegation`, `@koi/capability-verifier`, `@koi/middleware-delegation-escalation`, `@koi/middleware-intent-capsule`, `@koi/scope`
- `@koi/governance-memory`, `@koi/security-analyzer`, `@koi/collusion-detector`, `@koi/reputation`, `@koi/doctor`

Required coverage:

- fail-closed permissions behavior
- approval timeout and retry behavior
- audit log integrity under retries and partial failures
- budget accounting under multi-turn sessions and delegation
- data-protection precision and recall
- rollback and sandbox behavior under partial writes and execution failure
- delegation chain validation, attenuation, revocation, and scope enforcement

Failure injection:

- approval backend outage
- policy backend returning malformed verdicts
- audit sink outage
- PII false positive and false negative fixtures
- sandbox timeout, output truncation, and interrupted tool calls

Current suites already aligned with this area:

- `tests/e2e/call-limits.test.ts`
- `tests/e2e/forge-security-e2e.test.ts`
- `tests/e2e/tool-audit.test.ts`
- `tests/e2e/e2e-proposal-gate.test.ts`
- `tests/e2e/reputation-backend-e2e.test.ts`

Gap to add explicitly:

- one governed trading or browser-action scenario that exercises permissions, approval, audit, pay, sandbox, and rollback in a single flow

## 7. Multi-Agent, Workspaces, Scratchpads, and Federation

Packages:

- `@koi/task-spawn`, `@koi/handoff`
- `@koi/ipc-local`, `@koi/ipc-nexus`
- `@koi/scratchpad-local`, `@koi/scratchpad-nexus`
- `@koi/workspace`, `@koi/workspace-nexus`
- `@koi/federation`
- `@koi/name-service`, `@koi/name-service-nexus`
- `@koi/agent-spawner`, `@koi/autonomous`, `@koi/node`, `@koi/node-stack`

Required coverage:

- manager-to-worker delegation with artifact passing
- isolated workspace provisioning and cleanup
- scratchpad/shared-state coordination
- correlation IDs and message routing
- remote execution routing and zone discovery
- federation replay and conflict resolution

Failure injection:

- worker crash during handoff
- missing workspace cleanup
- duplicate or delayed IPC delivery
- split-brain or stale routing information in federation

Current suites already aligned with this area:

- `tests/e2e/ipc-nexus-e2e.test.ts`
- `tests/e2e/ipc-nexus-realllm-e2e.test.ts`
- `tests/e2e/e2e-delegation-manager.test.ts`
- `tests/e2e/e2e-delegation-consolidation.test.ts`

Gap to add explicitly:

- a worktree-backed coding swarm scenario with task spawn, workspace isolation, handoff, and final consolidation

## 8. Engines, Routing, Browser Automation, and Sandbox Backends

Packages:

- `@koi/engine-pi`, `@koi/engine-external`, `@koi/engine-acp`, `@koi/engine-claude`, `@koi/engine-loop`, `@koi/engine-rlm`
- `@koi/model-router`
- `@koi/browser-playwright`
- `@koi/code-executor`
- all `@koi/sandbox*` packages

Required coverage:

- engine event mapping and content-block fidelity
- tool and middleware interception across all engines
- PTY handling and long-lived subprocess cleanup for external engines
- route selection, fallback, escalation, and circuit breaking
- browser a11y snapshot stability and SSRF/private-IP blocking
- backend parity across local and cloud sandboxes

Failure injection:

- malformed provider responses
- idle external process never emitting completion sentinel
- navigation invalidating Playwright refs
- sandbox cold starts, timeouts, and artifact capture failures

Current suites already aligned with this area:

- `tests/e2e/engine-external-e2e.test.ts`
- `tests/e2e/pi-agent.test.ts`

Gap to add explicitly:

- an engine matrix suite that runs the same small manifest across `pi`, `loop`, `external`, and `acp` and validates shared observable behavior

## 9. Deployment, Long-Running Agents, Scheduling, and Durability

Packages:

- `@koi/deploy`, `@koi/nexus-embed`, `@koi/bundle`
- `@koi/scheduler`, `@koi/scheduler-provider`, `@koi/scheduler-nexus`
- `@koi/long-running`, `@koi/harness-scheduler`
- `@koi/temporal`
- `@koi/verified-loop`

Required coverage:

- service install, uninstall, start, stop, logs, and status behavior
- checkpoint and resume behavior over restart
- cron scheduling correctness, concurrency, retry, and DLQ semantics
- distributed scheduler consistency when backed by Nexus
- Temporal resume, signal, and termination paths
- bundle export/import integrity and trust downgrade behavior

Failure injection:

- Nexus absent during embed startup
- restart in the middle of a checkpoint
- duplicate scheduled delivery
- dead-letter retries interacting with governance and audit middleware

Gap to add explicitly:

- a soak-style 24-hour autonomous run covering scheduler, checkpointing, restart recovery, and admin visibility

## 10. Forge, Evaluation, and Release Gates

Packages:

- `@koi/forge`, `@koi/forge-demand`, `@koi/crystallize`
- `@koi/forge-verifier`, `@koi/forge-integrity`, `@koi/forge-policy`
- `@koi/forge-optimizer`, `@koi/forge-exaptation`, `@koi/forge-tools`, `@koi/forge-types`
- `@koi/eval`, `@koi/self-test`, `@koi/quality-gate`, `@koi/doctor`

Required coverage:

- content hashing, provenance, and trust-tier assignment
- verifier behavior over dependency audit, sandbox execution, adversarial checks, and policy checks
- re-verification on updates and drift
- eval baseline comparison and regression gating
- doctor/self-test behavior as release blockers

Failure injection:

- forged artifact tampering
- dependency or policy verification failure
- trust-tier downgrade after regression
- stale published descriptor pointing at replaced content

Current suites already aligned with this area:

- `tests/e2e/forge-security-e2e.test.ts`
- `tests/e2e/e2e-brick-id-content-addressing.test.ts`
- `tests/e2e/promote-atomic-e2e.test.ts`

Gap to add explicitly:

- a full forge pipeline test from demand detection through promotion plus eval gate, with an intentional regression forcing a downgrade

## Cross-Cutting Matrices

These matrices should be maintained even when package work is local:

- channel matrix: all `@koi/channel-*` packages against common message/content/thread fixtures
- backend matrix: local filesystem/SQLite/memory versus Nexus-backed implementations
- sandbox matrix: `sandbox`, `docker`, `wasm`, and one remote backend under the same execution fixtures
- engine matrix: `pi`, `loop`, `external`, `acp`, and `claude` for shared lifecycle semantics
- admin matrix: dashboard API, web UI, and TUI against the same live agent state
- persistence matrix: transcript/session/snapshot/scratchpad/workspace recovery across restart

## Release Gate Recommendation

For a high-confidence release, require this order:

1. package tests across all changed families
2. contract suites from `@koi/test-utils*`
3. manifest and runtime assembly e2e
4. governance and sandbox e2e
5. one admin/TUI operator flow
6. one multi-agent workspace flow
7. one forge/eval/self-test flow
8. one long-running or scheduled resilience run when scheduler, deploy, or Nexus layers changed

## Package-Family Focus

Use the appendix for package-by-package detail. At the family level, test emphasis should be:

- `kernel`: manifest correctness, runtime lifecycle, supervision, composition
- `meta`: bundle wiring, CLI ergonomics, stack defaults, distribution correctness
- `ui`: TUI state transitions, reconnects, admin interoperability
- `middleware`: ordering, retries, repair, observability, containment
- `security`: fail-closed enforcement, audit integrity, delegation chain safety
- `forge`: provenance, verification, trust, promotion, regression handling
- `fs`: tool correctness, skill discovery, search/storage backends, MCP interop
- `mm`: memory injection, conversation continuity, transcript durability, compaction
- `ipc`: coordination, handoff, workspace isolation, federation
- `net`: channel parity, gateway contracts, webhook and rich-surface transforms
- `drivers`: engine semantics, browser automation, route selection
- `virt`: sandbox parity, timeout/escape resistance, artifact capture
- `observability`: dashboard/API/TUI/procfs/debug/tracing alignment
- `sched`: cron, retry, DLQ, checkpoint, durable execution
- `deploy`: health, service lifecycle, embed mode, bundle portability
- `lib`: contracts, primitives, shutdown, validation, storage clients, test harnesses
