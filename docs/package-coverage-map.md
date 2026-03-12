# Package Coverage Map

This appendix is generated from the current workspace `package.json` files and local package test files. Use it with `docs/user-guide.md` when the main guide gets too high-level and you need package-by-package coverage.

Current snapshot:

- 226 workspace packages
- 17 package families
- 226 packages with local test files
- 130 packages with dedicated package docs

## Family Summary

| Family | Packages | Test files | Dedicated package docs |
| --- | ---: | ---: | ---: |
| kernel | 8 | 134 | 3 |
| meta | 20 | 113 | 19 |
| ui | 1 | 10 | 0 |
| middleware | 18 | 110 | 13 |
| security | 22 | 158 | 17 |
| forge | 9 | 33 | 4 |
| fs | 29 | 215 | 16 |
| mm | 16 | 114 | 12 |
| ipc | 9 | 78 | 6 |
| net | 30 | 199 | 19 |
| drivers | 8 | 82 | 5 |
| virt | 11 | 70 | 2 |
| observability | 11 | 104 | 5 |
| sched | 6 | 56 | 4 |
| deploy | 4 | 45 | 2 |
| exec | 1 | 8 | 0 |
| lib | 23 | 94 | 3 |

## Package Inventory

Each line shows package name, package description, test-file count, and any existing package doc paths.

## kernel (8)

- `@koi/bootstrap` (packages/kernel/bootstrap) - Resolve .koi/{INSTRUCTIONS,TOOLS,CONTEXT}.md files for agent bootstrap context. Tests: 3. Docs: docs/L2/bootstrap.md.
- `@koi/config` (packages/kernel/config) - Provide runtime policy configuration with hot-reload, validation, and engine integration. Tests: 12. Docs: docs/L2/config.md.
- `@koi/core` (packages/kernel/core) - Define interfaces-only kernel with 7 core contracts and ECS compositional layer. Tests: 29.
- `@koi/engine` (packages/kernel/engine) - Manage kernel runtime including guards, lifecycle, middleware composition, and adapters. Tests: 49.
- `@koi/engine-compose` (packages/kernel/engine-compose) - Middleware composition and guard factories for the Koi kernel. Tests: 3.
- `@koi/engine-reconcile` (packages/kernel/engine-reconcile) - Reconciliation, supervision, and process management for the Koi kernel. Tests: 20.
- `@koi/manifest` (packages/kernel/manifest) - Load and validate YAML agent definitions with environment interpolation. Tests: 10.
- `@koi/soul` (packages/kernel/soul) - Inject unified agent personality through system prompts across soul, identity, and user layers. Tests: 8. Docs: docs/L2/soul.md.

## meta (20)

- `@koi/agent-spawner` (packages/meta/agent-spawner) - Spawn external coding agents inside sandboxed containers with ACP or stdio communication. Tests: 4. Docs: docs/L2/agent-spawner.md, docs/L3/agent-spawner.md.
- `@koi/autonomous` (packages/meta/autonomous) - Compose long-running harness, scheduler, and checkpoint/inbox middleware into autonomous agents. Tests: 6. Docs: docs/L2/autonomous.md.
- `@koi/channels` (packages/meta/channels) - Channel adapter registry and manifest-driven channel resolution. Tests: 4. Docs: docs/L3/channels.md.
- `@koi/cli` (packages/meta/cli) - Interactive command-line interface for agent initialization and local execution. Tests: 17. Docs: docs/L3/cli.md.
- `@koi/context-arena` (packages/meta/context-arena) - Compose all context sources - personality, bootstrap, conversation, memory - with budget allocation. Tests: 5. Docs: docs/L3/context-arena.md.
- `@koi/forge` (packages/meta/forge) - Self-extending system for agent composition, verification, integrity attestation, and policy enforcement. Tests: 20. Docs: docs/L2/forge.md.
- `@koi/goal-stack` (packages/meta/goal-stack) - Goal-directed middleware bundle composing anchor, reminder, and planning middleware. Tests: 4. Docs: docs/L3/goal-stack.md.
- `@koi/governance` (packages/meta/governance) - Enterprise compliance stack composing 11 middleware for permissions, approvals, auditing, and guardrails. Tests: 7. Docs: docs/L3/governance.md.
- `@koi/ipc-stack` (packages/meta/ipc-stack) - IPC meta-package composing messaging, delegation, workspace, scratchpad, and federation via createIpcStack(). Tests: 4. Docs: docs/L3/ipc-stack.md.
- `@koi/nexus` (packages/meta/nexus) - One-line Nexus wiring: single config, all backends auto-wired, auto-provisioned, auto-scoped per agent. Tests: 6. Docs: docs/L3/nexus.md.
- `@koi/node-stack` (packages/meta/node-stack) - Convenience bundle wiring @koi/node with agent-discovery, procfs, debug, and tracing.. Tests: 2. Docs: docs/L3/node-stack.md.
- `@koi/quality-gate` (packages/meta/quality-gate) - Output quality assurance middleware bundle for Koi agents. Tests: 6. Docs: docs/L3/quality-gate.md.
- `@koi/retry-stack` (packages/meta/retry-stack) - Intelligent retry and recovery middleware bundle for Koi agents. Tests: 5. Docs: docs/L3/retry-stack.md.
- `@koi/rlm-stack` (packages/meta/rlm-stack) - Wire code-execution sandbox into RLM middleware for script-based input analysis. Tests: 3. Docs: docs/L3/rlm-stack.md.
- `@koi/sandbox-stack` (packages/meta/sandbox-stack) - Unified L3 bundle for sandboxed code execution - cloud dispatch, stack composition, timeout guards, and middleware. Tests: 5. Docs: docs/L3/sandbox-stack.md.
- `@koi/skill-stack` (packages/meta/skill-stack) - Compose skill providers with progressive loading, gating, hot-plug, and file watching. Tests: 3. Docs: docs/L3/skill-stack.md.
- `@koi/starter` (packages/meta/starter) - Auto-wire manifest-declared middleware without manual factory calls, with callback customization. Tests: 3.
- `@koi/tool-stack` (packages/meta/tool-stack) - Tool lifecycle stack composing 7 middleware for audit, limits, recovery, dedup, and sandbox. Tests: 2. Docs: docs/L3/tool-stack.md.
- `@koi/workspace-stack` (packages/meta/workspace-stack) - Backend factory for Nexus-backed agent workspaces. Tests: 1. Docs: docs/L3/workspace-stack.md.
- `koi` (packages/meta/koi) - Self-extending agent engine - single package distribution. Tests: 6. Docs: docs/L4/koi.md.

## ui (1)

- `@koi/tui` (packages/ui/tui) - Admin-panel-connected terminal console for operators. Tests: 10.

## middleware (18)

- `@koi/middleware-call-dedup` (packages/middleware/middleware-call-dedup) - Cache identical tool call results per session to avoid redundant re-execution. Tests: 4. Docs: docs/L2/middleware-call-dedup.md.
- `@koi/middleware-call-limits` (packages/middleware/middleware-call-limits) - Enforce per-session and per-tool call count limits with configurable exit behavior. Tests: 5.
- `@koi/middleware-degenerate` (packages/middleware/middleware-degenerate) - Select primary implementation for capabilities with multiple variants and handle failover. Tests: 1. Docs: docs/L2/middleware-degenerate.md.
- `@koi/middleware-event-rules` (packages/middleware/middleware-event-rules) - Declarative YAML rule engine mapping engine events to actions - no middleware code needed. Tests: 7. Docs: docs/L2/middleware-event-rules.md.
- `@koi/middleware-feedback-loop` (packages/middleware/middleware-feedback-loop) - Validate model and tool outputs, retry with error feedback, enforce quality gates. Tests: 17. Docs: docs/L2/middleware-feedback-loop.md.
- `@koi/middleware-fs-rollback` (packages/middleware/middleware-fs-rollback) - Capture filesystem snapshots during tool calls and enable rollback to prior states. Tests: 4.
- `@koi/middleware-goal` (packages/middleware/middleware-goal) - Goal-directed middleware trio: anchor (todo injection), reminder (adaptive periodic), and planning (write_plan tool). Tests: 11. Docs: docs/L2/middleware-goal.md.
- `@koi/middleware-guided-retry` (packages/middleware/middleware-guided-retry) - Inject constraint hints into model calls after backtrack or fork events. Tests: 4.
- `@koi/middleware-output-verifier` (packages/middleware/middleware-output-verifier) - Run deterministic and LLM-as-judge quality checks before delivering model outputs. Tests: 4. Docs: docs/L2/middleware-output-verifier.md.
- `@koi/middleware-reflex` (packages/middleware/middleware-reflex) - Rule-based short-circuit middleware for known message patterns. Tests: 4. Docs: docs/L2/middleware-reflex.md.
- `@koi/middleware-report` (packages/middleware/middleware-report) - Generate human-readable summaries of autonomous agent run activities and outcomes. Tests: 6. Docs: docs/L2/middleware-report.md.
- `@koi/middleware-rlm` (packages/middleware/middleware-rlm) - Virtualize unbounded input as middleware - any engine can process inputs larger than context window. Tests: 12. Docs: docs/L2/middleware-rlm.md.
- `@koi/middleware-sandbox` (packages/middleware/middleware-sandbox) - Enforce timeout, output truncation, and error classification for sandboxed tools. Tests: 3.
- `@koi/middleware-semantic-retry` (packages/middleware/middleware-semantic-retry) - Analyze failure root causes and rewrite prompts with context-aware retry actions. Tests: 4. Docs: docs/L2/middleware-semantic-retry.md.
- `@koi/middleware-tool-audit` (packages/middleware/middleware-tool-audit) - Track per-tool usage, latency, success rates and emit lifecycle signals. Tests: 4. Docs: docs/L2/middleware-tool-audit.md.
- `@koi/middleware-tool-recovery` (packages/middleware/middleware-tool-recovery) - Recover structured tool calls from text patterns in model responses. Tests: 8. Docs: docs/L2/middleware-tool-recovery.md.
- `@koi/middleware-tool-selector` (packages/middleware/middleware-tool-selector) - Pre-filter tools before model calls using profile or selector function. Tests: 9. Docs: docs/L2/middleware-tool-selector.md.
- `@koi/middleware-turn-ack` (packages/middleware/middleware-turn-ack) - Send processing and idle status signals for long-running agent turns. Tests: 3.

## security (22)

- `@koi/audit-sink-local` (packages/security/audit-sink-local) - Persist audit events to SQLite or NDJSON files for offline operation. Tests: 3.
- `@koi/audit-sink-nexus` (packages/security/audit-sink-nexus) - Batch and forward audit entries to Nexus server via JSON-RPC with retry. Tests: 2. Docs: docs/L2/audit-sink-nexus.md.
- `@koi/capability-verifier` (packages/security/capability-verifier) - Verify HMAC and Ed25519 capability tokens, track session revocation, validate delegation chains. Tests: 6. Docs: docs/L2/capability-verifier.md.
- `@koi/collusion-detector` (packages/security/collusion-detector) - Detect agent collusion via synchronous moves, variance collapse, concentration, specialization. Tests: 4. Docs: docs/L2/collusion-detector.md.
- `@koi/delegation` (packages/security/delegation) - Create monotonically attenuated delegation tokens with scope checking and cascading revocation. Tests: 28. Docs: docs/L2/delegation.md.
- `@koi/doctor` (packages/security/doctor) - Static security analysis of agent manifests aligned with OWASP Agentic Top 10. Tests: 21. Docs: docs/L2/doctor.md.
- `@koi/exec-approvals` (packages/security/exec-approvals) - Enforce progressive command allowlisting with user approval decisions across session. Tests: 10. Docs: docs/L2/exec-approvals.md.
- `@koi/governance-memory` (packages/security/governance-memory) - Evaluate Cedar-inspired constraint DAGs with adaptive thresholds and anomaly integration. Tests: 8. Docs: docs/L2/governance-memory.md.
- `@koi/middleware-audit` (packages/security/middleware-audit) - Log structured audit entries for all model/tool calls with PII redaction support. Tests: 4.
- `@koi/middleware-delegation-escalation` (packages/security/middleware-delegation-escalation) - Escalate to humans when delegatee circuit breakers exhaust via bidirectional channel. Tests: 4. Docs: docs/L2/middleware-delegation-escalation.md.
- `@koi/middleware-governance-backend` (packages/security/middleware-governance-backend) - Wrap model/tool calls with fail-closed policy evaluation gate. Tests: 3. Docs: docs/L2/middleware-governance-backend.md.
- `@koi/middleware-guardrails` (packages/security/middleware-guardrails) - Validate agent outputs against Zod schemas to prevent malformed responses and data leaks. Tests: 6.
- `@koi/middleware-intent-capsule` (packages/security/middleware-intent-capsule) - Sign and verify agent mandate (system prompt + objectives) to defend against goal hijacking. Tests: 2. Docs: docs/L2/middleware-intent-capsule.md.
- `@koi/middleware-pay` (packages/security/middleware-pay) - Track token costs per call, enforce budget limits, and alert on threshold crossings. Tests: 4. Docs: docs/L2/middleware-pay.md.
- `@koi/middleware-permissions` (packages/security/middleware-permissions) - Check tool access via pluggable backend with human-in-the-loop approval support. Tests: 7. Docs: docs/L2/middleware-permissions.md.
- `@koi/middleware-pii` (packages/security/middleware-pii) - Detect and redact PII (email, SSN, card, IP, MAC, phone, URL) in agent I/O. Tests: 5.
- `@koi/middleware-sanitize` (packages/security/middleware-sanitize) - Strip injection patterns, control characters, HTML tags, and zero-width chars from content. Tests: 8.
- `@koi/permissions-nexus` (packages/security/permissions-nexus) - Forward permission queries to Nexus ReBAC server with typed contract implementations. Tests: 7. Docs: docs/L2/permissions-nexus.md.
- `@koi/redaction` (packages/security/redaction) - Mask secrets (API keys, credentials, tokens) in logs with 13 built-in pattern detectors. Tests: 12. Docs: docs/L2/redaction.md.
- `@koi/reputation` (packages/security/reputation) - Calculate weighted trust scores from feedback for pluggable agent reputation backend. Tests: 3. Docs: docs/L2/reputation.md.
- `@koi/scope` (packages/security/scope) - Wrap infrastructure tokens with capability-attenuation scopes (filesystem, browser, credentials, memory). Tests: 7. Docs: docs/L2/scope.md.
- `@koi/security-analyzer` (packages/security/security-analyzer) - Classify tool call risk via pattern matching and multi-analyzer aggregation with anomaly elevation. Tests: 4. Docs: docs/L2/security-analyzer.md.

## forge (9)

- `@koi/crystallize` (packages/forge/crystallize) - Detect repeating tool patterns and surface crystallization candidates for forging. Tests: 8. Docs: docs/L2/crystallize.md.
- `@koi/forge-demand` (packages/forge/forge-demand) - Detect capability gaps and repeated failures that demand new tool creation. Tests: 7. Docs: docs/L2/forge-demand.md.
- `@koi/forge-exaptation` (packages/forge/forge-exaptation) - Monitor tool usage for purpose drift when bricks diverge from design. Tests: 6. Docs: docs/L2/forge-exaptation.md.
- `@koi/forge-integrity` (packages/forge/forge-integrity) - Verify provenance, sign attestations, and serialize SLSA v1.0 predicates. Tests: 1.
- `@koi/forge-optimizer` (packages/forge/forge-optimizer) - Evaluate composite bricks against components and auto-deprecate underperforming ones. Tests: 2. Docs: docs/L2/forge-optimizer.md.
- `@koi/forge-policy` (packages/forge/forge-policy) - Enforce governance, track usage, detect drift, and re-verify brick changes. Tests: 1.
- `@koi/forge-tools` (packages/forge/forge-tools) - Provide primordial tools, component provider, resolver, and store utilities. Tests: 6.
- `@koi/forge-types` (packages/forge/forge-types) - Define shared types, errors, config, and interfaces for the forge subsystem. Tests: 1.
- `@koi/forge-verifier` (packages/forge/forge-verifier) - Verify bricks with adversarial probes, dependency audits, and test generation. Tests: 1.

## fs (29)

- `@koi/catalog` (packages/fs/catalog) - Search bundled packages, forged bricks, MCP tools, and skill registry entries via unified discovery. Tests: 10.
- `@koi/code-mode` (packages/fs/code-mode) - Propose and apply atomic code plans through a two-phase workflow with filesystem validation. Tests: 13.
- `@koi/events-memory` (packages/fs/events-memory) - Store events in memory with replay, named subscriptions, and dead letter queue capability. Tests: 1.
- `@koi/events-sqlite` (packages/fs/events-sqlite) - Persist durable events using SQLite with WAL mode, crash recovery, and TTL-based eviction. Tests: 2. Docs: docs/L2/events-sqlite.md.
- `@koi/filesystem` (packages/fs/filesystem) - Expose filesystem backend operations as discoverable Tool components across all engines. Tests: 8. Docs: docs/L2/filesystem.md.
- `@koi/filesystem-nexus` (packages/fs/filesystem-nexus) - Nexus-backed FileSystemBackend implementation via JSON-RPC. Tests: 1. Docs: docs/L2/filesystem-nexus.md.
- `@koi/lsp` (packages/fs/lsp) - Bridge any LSP server (TypeScript, Python, Go, Rust, etc.) into Koi's ECS tool system. Tests: 14.
- `@koi/nexus-store` (packages/fs/nexus-store) - Consolidate Nexus-backed persistence adapters for forge, events, snapshots, sessions, and memory. Tests: 5. Docs: docs/L2/nexus-store.md.
- `@koi/pay-local` (packages/fs/pay-local) - Track credits with fully-functional in-memory ledger and optional SQLite persistence. Tests: 2.
- `@koi/pay-nexus` (packages/fs/pay-nexus) - Persist credits to Nexus via TigerBeetle + PostgreSQL payment ledger backend. Tests: 5. Docs: docs/L2/pay-nexus.md.
- `@koi/registry-http` (packages/fs/registry-http) - Read skill registry via REST with LRU + TTL cache; fail-open search. Tests: 2.
- `@koi/registry-memory` (packages/fs/registry-memory) - In-memory AgentRegistry backed by event sourcing. Tests: 2. Docs: docs/L2/registry-memory.md.
- `@koi/registry-nexus` (packages/fs/registry-nexus) - Keep agent state in sync with Nexus via periodic polling projection cache. Tests: 8. Docs: docs/L2/registry-nexus.md.
- `@koi/registry-sqlite` (packages/fs/registry-sqlite) - Store bricks, skills, and versions in SQLite with FTS5 search and keyset pagination. Tests: 14.
- `@koi/resolve` (packages/fs/resolve) - Auto-resolve koi.yaml manifest to runtime instances via BrickDescriptor registry. Tests: 15.
- `@koi/search` (packages/fs/search) - Provide pluggable BM25 (keyword), vector (semantic), and hybrid search backends. Tests: 15.
- `@koi/search-brave` (packages/fs/search-brave) - Query Brave Search API via SearchProvider contract for manifest auto-resolution. Tests: 1. Docs: docs/L2/search-brave.md.
- `@koi/search-nexus` (packages/fs/search-nexus) - Plug Nexus search API v2 as backend for @koi/search hybrid retrieval. Tests: 6. Docs: docs/L2/search-nexus.md.
- `@koi/search-provider` (packages/fs/search-provider) - Define contracts for web search, index search, embedders, indexers, and retrievers. Tests: 2. Docs: docs/L2/search-provider.md.
- `@koi/skill-scanner` (packages/fs/skill-scanner) - Detect malicious code in Koi forge via AST analysis with built-in rule library. Tests: 16.
- `@koi/skills` (packages/fs/skills) - Parse SKILL.md files with 3-level progressive loading to minimize context usage. Tests: 14. Docs: docs/L2/skills.md.
- `@koi/store-fs` (packages/fs/store-fs) - Hash-sharded filesystem storage with hybrid metadata indexing and 4-tier overlay. Tests: 9.
- `@koi/store-sqlite` (packages/fs/store-sqlite) - Persist bricks to SQLite with WAL mode and parameterized STRICT table schema. Tests: 1.
- `@koi/tool-ask-guide` (packages/fs/tool-ask-guide) - Query knowledge sources within token budget and return results for guidance. Tests: 3.
- `@koi/tool-ask-user` (packages/fs/tool-ask-user) - Elicit structured responses (multi-choice or free-text) mid-execution. Tests: 3. Docs: docs/L2/tool-ask-user.md.
- `@koi/tool-browser` (packages/fs/tool-browser) - Automate browser via accessibility tree snapshots (100x cheaper than screenshots). Tests: 22. Docs: docs/L2/tool-browser.md.
- `@koi/tool-exec` (packages/fs/tool-exec) - Execute ephemeral code in sandbox with input validation and timeout enforcement. Tests: 2. Docs: docs/L2/tool-exec.md.
- `@koi/tools-github` (packages/fs/tools-github) - Manage PR lifecycle (create, review, merge) and CI waits via GitHub CLI. Tests: 9. Docs: docs/L2/tools-github.md.
- `@koi/tools-web` (packages/fs/tools-web) - Fetch and search the web with SSRF protection and result caching. Tests: 10. Docs: docs/L2/tools-web.md.

## mm (16)

- `@koi/context` (packages/mm/context) - Hydrate agent context from multiple sources at session start and inject as system message. Tests: 10.
- `@koi/memory-fs` (packages/mm/memory-fs) - Store and retrieve memories using filesystem-backed categorized fact store with search. Tests: 23. Docs: docs/L2/memory-fs.md.
- `@koi/middleware-ace` (packages/mm/middleware-ace) - Record trajectories and consolidate learnings into persistent playbooks per session. Tests: 20.
- `@koi/middleware-collective-memory` (packages/mm/middleware-collective-memory) - Middleware for cross-run learning persistence via brick collective memory.. Tests: 5. Docs: docs/L2/middleware-collective-memory.md.
- `@koi/middleware-compactor` (packages/mm/middleware-compactor) - Compact old conversation history into structured summaries at configurable thresholds. Tests: 18. Docs: docs/L2/middleware-compactor.md.
- `@koi/middleware-context-editing` (packages/mm/middleware-context-editing) - Replace old tool results with placeholders when token count exceeds threshold. Tests: 2.
- `@koi/middleware-conversation` (packages/mm/middleware-conversation) - Link stateless channel sessions by loading thread history and persisting new turns. Tests: 6. Docs: docs/L2/middleware-conversation.md.
- `@koi/middleware-hot-memory` (packages/mm/middleware-hot-memory) - Inject hot-tier memories into model calls at configurable intervals. Tests: 1. Docs: docs/L2/middleware-hot-memory.md.
- `@koi/middleware-user-model` (packages/mm/middleware-user-model) - Unified user modeling middleware combining preference learning, drift detection, and sensor enrichment. Tests: 9. Docs: docs/L2/middleware-user-model.md.
- `@koi/session-repair` (packages/mm/session-repair) - Validate and repair message history through orphan repair, dedup, and merge phases. Tests: 3. Docs: docs/L2/session-repair.md.
- `@koi/session-store` (packages/mm/session-store) - Persist sessions durably to enable crash recovery and resume capabilities. Tests: 2. Docs: docs/L2/session-store.md.
- `@koi/snapshot-chain-store` (packages/mm/snapshot-chain-store) - Store snapshot chains in memory with full DAG topology and ancestor walking. Tests: 3.
- `@koi/snapshot-store-sqlite` (packages/mm/snapshot-store-sqlite) - Persist snapshot chains durably with WAL-mode storage and content-hash dedup. Tests: 2. Docs: docs/L2/snapshot-store-sqlite.md.
- `@koi/token-estimator` (packages/mm/token-estimator) - Estimate tokens using configurable heuristics (default: 4 chars per token). Tests: 2. Docs: docs/L2/token-estimator.md.
- `@koi/tool-squash` (packages/mm/tool-squash) - Compress old messages with agent-provided summary and archive originals to store. Tests: 5. Docs: docs/L2/tool-squash.md.
- `@koi/transcript` (packages/mm/transcript) - Log messages durably as append-only JSONL or in-memory transcript for recovery. Tests: 3. Docs: docs/L2/transcript.md.

## ipc (9)

- `@koi/federation` (packages/ipc/federation) - Coordinate multi-zone agents with vector clock sync and conflict resolution. Tests: 14. Docs: docs/L2/federation.md.
- `@koi/handoff` (packages/ipc/handoff) - Relay typed context between agents via structured handoff tools and middleware. Tests: 12. Docs: docs/L2/handoff.md.
- `@koi/ipc-local` (packages/ipc/ipc-local) - Route messages between in-process agents using in-memory mailbox dispatch. Tests: 3.
- `@koi/ipc-nexus` (packages/ipc/ipc-nexus) - Enable agent messaging via Nexus REST API with subscriptions and inbox listing. Tests: 13. Docs: docs/L2/ipc-nexus.md.
- `@koi/scratchpad-local` (packages/ipc/scratchpad-local) - Store versioned files with CAS and TTL in in-memory scratchpad. Tests: 2.
- `@koi/scratchpad-nexus` (packages/ipc/scratchpad-nexus) - Persist agent scratchpad state across zones via Nexus group-scoped storage. Tests: 4. Docs: docs/L2/scratchpad-nexus.md.
- `@koi/task-spawn` (packages/ipc/task-spawn) - Inject task tool for zero-friction delegation to pre-registered subagent types. Tests: 16. Docs: docs/L2/task-spawn.md.
- `@koi/workspace` (packages/ipc/workspace) - Isolate agent workspaces via pluggable backends (git worktrees, Docker, etc.). Tests: 12.
- `@koi/workspace-nexus` (packages/ipc/workspace-nexus) - Sync workspace metadata across devices via Nexus Raft-replicated store. Tests: 2. Docs: docs/L2/workspace-nexus.md.

## net (30)

- `@koi/acp` (packages/net/acp) - Serve agent via IDE Agent Client Protocol (ACP v0.10.x) over stdin/stdout. Tests: 9. Docs: docs/L2/acp.md.
- `@koi/acp-protocol` (packages/net/acp-protocol) - Define ACP wire types, JSON-RPC parser, transport interface, and content/event mapping. Tests: 6. Docs: docs/L2/acp-protocol.md.
- `@koi/canvas` (packages/net/canvas) - Implement A2UI v0.9 headless protocol for agent-generated visual workspaces. Tests: 10. Docs: docs/L2/canvas.md.
- `@koi/channel-agui` (packages/net/channel-agui) - AG-UI SSE channel adapter - connect CopilotKit-compatible web frontends to Koi agents. Tests: 7.
- `@koi/channel-base` (packages/net/channel-base) - Build ChannelAdapters with lifecycle, capability-aware rendering, and retry handling. Tests: 11. Docs: docs/L2/channel-base.md.
- `@koi/channel-canvas-fallback` (packages/net/channel-canvas-fallback) - Replace A2UI blocks with text links for text-only channels. Tests: 5.
- `@koi/channel-chat-sdk` (packages/net/channel-chat-sdk) - Wrap Slack, Discord, Teams, Google Chat, GitHub, Linear into unified adapters. Tests: 8. Docs: docs/L2/channel-chat-sdk.md.
- `@koi/channel-cli` (packages/net/channel-cli) - Read user input via readline, write output to stdout. Tests: 1.
- `@koi/channel-discord` (packages/net/channel-discord) - Connect Discord bots with text, voice, buttons, and embeds. Tests: 13. Docs: docs/L2/channel-discord.md.
- `@koi/channel-email` (packages/net/channel-email) - Receive email via IMAP IDLE and send via SMTP. Tests: 8.
- `@koi/channel-matrix` (packages/net/channel-matrix) - Connect Matrix homeservers with auto-join and debouncing. Tests: 4. Docs: docs/L2/channel-matrix.md.
- `@koi/channel-mobile` (packages/net/channel-mobile) - Serve native mobile apps via WebSocket with JSON frames. Tests: 6. Docs: docs/L2/channel-mobile.md.
- `@koi/channel-signal` (packages/net/channel-signal) - Communicate via signal-cli JSON-RPC subprocess. Tests: 6. Docs: docs/L2/channel-signal.md.
- `@koi/channel-slack` (packages/net/channel-slack) - Connect Slack bots via Socket Mode or HTTP Events API. Tests: 8.
- `@koi/channel-teams` (packages/net/channel-teams) - Connect Microsoft Teams bots via Bot Framework HTTP webhooks. Tests: 4. Docs: docs/L2/channel-teams.md.
- `@koi/channel-telegram` (packages/net/channel-telegram) - Connect Telegram bots with polling or webhook deployment. Tests: 4.
- `@koi/channel-voice` (packages/net/channel-voice) - Bridge real-time voice I/O via LiveKit with STT/TTS. Tests: 8. Docs: docs/L2/channel-voice.md.
- `@koi/channel-whatsapp` (packages/net/channel-whatsapp) - Connect WhatsApp bots via Baileys Web emulation. Tests: 6.
- `@koi/gateway` (packages/net/gateway) - Route messages, authenticate sessions, dispatch webhooks, and register nodes. Tests: 20. Docs: docs/L2/gateway.md.
- `@koi/gateway-canvas` (packages/net/gateway-canvas) - Canvas HTTP routes, SSE manager, and surface store for the Koi gateway.. Tests: 5. Docs: docs/L2/gateway-canvas.md.
- `@koi/gateway-nexus` (packages/net/gateway-nexus) - Nexus-backed gateway state stores for multi-instance HA deployment.. Tests: 7. Docs: docs/L2/gateway-nexus.md.
- `@koi/gateway-stack` (packages/net/gateway-stack) - Convenience bundle that wires gateway, canvas, and webhook with unified lifecycle.. Tests: 1. Docs: docs/L3/gateway-stack.md.
- `@koi/gateway-types` (packages/net/gateway-types) - Wire protocol types, session model, and config defaults for the Koi gateway.. Tests: 1.
- `@koi/gateway-webhook` (packages/net/gateway-webhook) - Webhook HTTP server and ingestion for the Koi gateway.. Tests: 2. Docs: docs/L2/gateway-webhook.md.
- `@koi/mcp` (packages/net/mcp) - Bridge MCP tool servers and attach discovered tools as Koi components. Tests: 14.
- `@koi/mcp-server` (packages/net/mcp-server) - Expose agent tools via Model Context Protocol. Tests: 1. Docs: docs/L2/mcp-server.md.
- `@koi/name-service` (packages/net/name-service) - Register and resolve agent names with TTL expiry and fuzzy suggestions. Tests: 6. Docs: docs/L2/name-service.md.
- `@koi/name-service-nexus` (packages/net/name-service-nexus) - Nexus-backed ANS backend with poll-based projection sync. Tests: 5. Docs: docs/L2/name-service-nexus.md.
- `@koi/webhook-delivery` (packages/net/webhook-delivery) - Deliver agent events as signed HTTP POSTs with retry and circuit breaking. Tests: 9.
- `@koi/webhook-provider` (packages/net/webhook-provider) - Expose read-only webhook health and configuration as agent tools. Tests: 4.

## drivers (8)

- `@koi/browser-playwright` (packages/drivers/browser-playwright) - Implement Playwright-based browser driver with accessibility tree serialization and stealth initialization. Tests: 5. Docs: docs/L2/browser-playwright.md.
- `@koi/engine-acp` (packages/drivers/engine-acp) - Orchestrate ACP-compatible coding agents as Koi backends via JSON-RPC over stdin/stdout. Tests: 4.
- `@koi/engine-claude` (packages/drivers/engine-claude) - Delegate to Claude Agent SDK query() with in-process MCP bridge for Koi tool execution. Tests: 10.
- `@koi/engine-external` (packages/drivers/engine-external) - Wrap any external process as engine adapter with single-shot, long-lived, and PTY modes. Tests: 14. Docs: docs/L2/engine-external.md.
- `@koi/engine-loop` (packages/drivers/engine-loop) - Execute pure TypeScript ReAct loop with parallel tool calls and iterative Reason+Act cycles. Tests: 3.
- `@koi/engine-pi` (packages/drivers/engine-pi) - Wrap pi-agent-core with full middleware interposition on model and tool calls. Tests: 10. Docs: docs/L2/engine-pi.md.
- `@koi/engine-rlm` (packages/drivers/engine-rlm) - Virtualize unbounded input outside context window with recursive chunking and sub-querying. Tests: 9. Docs: docs/L2/engine-rlm.md.
- `@koi/model-router` (packages/drivers/model-router) - Route model calls across multiple LLM providers with retry, fallback, cascade, and circuit breaker. Tests: 27. Docs: docs/L2/model-router.md.

## virt (11)

- `@koi/code-executor` (packages/virt/code-executor) - Execute scripts via Wasm sandbox for multi-tool orchestration in a single turn. Tests: 6. Docs: docs/L2/code-executor.md.
- `@koi/sandbox` (packages/virt/sandbox) - Provide OS-level sandboxing with macOS Seatbelt and Linux bubblewrap isolation. Tests: 13.
- `@koi/sandbox-cloud-base` (packages/virt/sandbox-cloud-base) - Share cloud sandbox utilities: bridge caching, error classification, truncation, tests. Tests: 9.
- `@koi/sandbox-cloudflare` (packages/virt/sandbox-cloudflare) - Execute code in Cloudflare Workers with optional R2 FUSE mount support. Tests: 5.
- `@koi/sandbox-daytona` (packages/virt/sandbox-daytona) - Execute code in Daytona cloud with native FUSE volume support. Tests: 5.
- `@koi/sandbox-docker` (packages/virt/sandbox-docker) - Execute code in Docker containers with offline support and iptables enforcement. Tests: 7.
- `@koi/sandbox-e2b` (packages/virt/sandbox-e2b) - Execute code in E2B Firecracker microVMs for remote sandboxed execution. Tests: 5.
- `@koi/sandbox-executor` (packages/virt/sandbox-executor) - Provide subprocess and promoted (in-process) executors for sandbox verification. Tests: 3. Docs: docs/L2/sandbox-executor.md.
- `@koi/sandbox-ipc` (packages/virt/sandbox-ipc) - Bridge OS-level sandboxing with forge verification via structured IPC. Tests: 9.
- `@koi/sandbox-vercel` (packages/virt/sandbox-vercel) - Execute code in Vercel Firecracker microVMs for remote sandboxed execution. Tests: 5.
- `@koi/sandbox-wasm` (packages/virt/sandbox-wasm) - Execute code in Wasm sandboxes with sync and async executor variants. Tests: 3.

## observability (11)

- `@koi/agent-discovery` (packages/observability/agent-discovery) - Discover external coding agents from PATH, filesystem, and MCP servers. Tests: 9. Docs: docs/L2/agent-discovery.md.
- `@koi/agent-monitor` (packages/observability/agent-monitor) - Detect anomalous agent behavior via adversarial middleware (excessive calls, errors). Tests: 6. Docs: docs/L2/agent-monitor.md.
- `@koi/agent-procfs` (packages/observability/agent-procfs) - Expose agent runtime state via virtual filesystem mounts with TTL microcache. Tests: 3. Docs: docs/L2/agent-procfs.md.
- `@koi/dashboard-api` (packages/observability/dashboard-api) - Serve REST endpoints + SSE events for agent/channel/skill dashboard metrics. Tests: 23.
- `@koi/dashboard-types` (packages/observability/dashboard-types) - Define shared dashboard event discriminated unions and REST API types. Tests: 2.
- `@koi/dashboard-ui` (packages/observability/dashboard-ui) - Web dashboard for observing agents, channels, skills, and system metrics. Tests: 26.
- `@koi/debug` (packages/observability/debug) - Attach runtime debugger with breakpoints, step/pause, and component inspection. Tests: 3. Docs: docs/L2/debug.md.
- `@koi/eval` (packages/observability/eval) - Run agent evaluation scenarios with graders, regression detection, and scoring. Tests: 14.
- `@koi/middleware-event-trace` (packages/observability/middleware-event-trace) - Trace individual LLM/tool calls for fine-grained mid-turn event replay. Tests: 3.
- `@koi/self-test` (packages/observability/self-test) - Execute pre-deployment smoke tests validating manifests, middleware, and E2E flows. Tests: 9.
- `@koi/tracing` (packages/observability/tracing) - Emit OpenTelemetry spans for session, turn, model, and tool lifecycle events. Tests: 6. Docs: docs/L2/tracing.md.

## sched (6)

- `@koi/harness-scheduler` (packages/sched/harness-scheduler) - Auto-resume suspended harness with poll-based scheduling and backoff. Tests: 2. Docs: docs/L2/harness-scheduler.md.
- `@koi/long-running` (packages/sched/long-running) - Manage agents over hours/days across sessions with checkpointing and context. Tests: 17. Docs: docs/L2/long-running.md.
- `@koi/scheduler` (packages/sched/scheduler) - Schedule tasks with priority queue, cron, retry, dead-letter, and concurrency. Tests: 12.
- `@koi/scheduler-nexus` (packages/sched/scheduler-nexus) - Nexus-backed distributed task store, schedule store, and priority queue for cross-node scheduling. Tests: 6. Docs: docs/L2/scheduler-nexus.md.
- `@koi/scheduler-provider` (packages/sched/scheduler-provider) - Expose scheduler as agent-facing tools scoped to individual agent identity. Tests: 13. Docs: docs/L2/scheduler-provider.md.
- `@koi/verified-loop` (packages/sched/verified-loop) - Shift control from LLM self-assessment to external objective verification loops. Tests: 6.

## deploy (4)

- `@koi/bundle` (packages/deploy/bundle) - Serialize and import portable agent bundles with integrity verification and deduplication. Tests: 6. Docs: docs/L2/bundle.md.
- `@koi/deploy` (packages/deploy/deploy) - Generate OS-native service files and manage agent lifecycle (systemd/launchd, health checks). Tests: 8.
- `@koi/nexus-embed` (packages/deploy/nexus-embed) - Auto-start local Nexus server for embed mode - spawn, health-check, PID management. Tests: 6. Docs: docs/L2/nexus-embed.md.
- `@koi/node` (packages/deploy/node) - Host multiplexed agents on local machines with WebSocket gateway, tool resolution, mDNS discovery. Tests: 25.

## exec (1)

- `@koi/temporal` (packages/exec/temporal) - Optional durable agent execution via Temporal - L3 package wrapping createKoi() with Entity Workflows. Tests: 8.

## lib (23)

- `@koi/crypto-utils` (packages/lib/crypto-utils) - Generate Ed25519 keys, sign and verify messages, compute SHA-256 hashes. Tests: 3. Docs: docs/L2/crypto-utils.md.
- `@koi/edit-match` (packages/lib/edit-match) - Search and replace files using cascading match strategies from exact to fuzzy. Tests: 4.
- `@koi/errors` (packages/lib/errors) - Provide KoiRuntimeError class, circuit breaker, retry logic, and filesystem error mapping. Tests: 6.
- `@koi/event-delivery` (packages/lib/event-delivery) - Manage event subscriptions with serialized delivery, retry, dead letter queue, and replay. Tests: 2.
- `@koi/execution-context` (packages/lib/execution-context) - Store and retrieve session context via AsyncLocalStorage for tool execution. Tests: 1.
- `@koi/failure-context` (packages/lib/failure-context) - Shared failure classification primitives: bounded history, running stats, detector interface. Tests: 2.
- `@koi/file-resolution` (packages/lib/file-resolution) - Read markdown files, resolve directory structures, enforce token budgets. Tests: 7. Docs: docs/L2/file-resolution.md.
- `@koi/git-utils` (packages/lib/git-utils) - Wrap git CLI commands and resolve worktree paths via Bun.spawn. Tests: 4.
- `@koi/hash` (packages/lib/hash) - Compute brick IDs, content hashes, HMACs, and ULIDs for L1 and L2 packages. Tests: 6.
- `@koi/name-resolution` (packages/lib/name-resolution) - Pure ANS algorithms: composite keys, name validation, scope resolution, fuzzy matching. Tests: 5.
- `@koi/nexus-client` (packages/lib/nexus-client) - Provide JSON-RPC 2.0 transport and path builders for Nexus services. Tests: 5. Docs: docs/L2/nexus-client.md.
- `@koi/preset-resolver` (packages/lib/preset-resolver) - Generic 3-layer config resolution: defaults -> preset -> user overrides. Tests: 3.
- `@koi/session-state` (packages/lib/session-state) - Per-session state management with FIFO eviction for middleware authors. Tests: 1.
- `@koi/shutdown` (packages/lib/shutdown) - Handle graceful shutdown signals and map exit codes for CLI and deploy. Tests: 3.
- `@koi/sqlite-utils` (packages/lib/sqlite-utils) - Wrap SQLite operations, map errors, open databases with optimized PRAGMAs. Tests: 1.
- `@koi/task-board` (packages/lib/task-board) - Immutable TaskBoard implementation with DAG validation, topological sort, and board helpers. Tests: 4.
- `@koi/test-utils` (packages/lib/test-utils) - Provide mock agents, contract test suites, and spy utilities for testing. Tests: 1.
- `@koi/test-utils-contracts` (packages/lib/test-utils-contracts) - Interface conformance contract test suites for Koi. Tests: 3.
- `@koi/test-utils-mocks` (packages/lib/test-utils-mocks) - Mock factories and spy helpers for Koi testing. Tests: 5.
- `@koi/test-utils-store-contracts` (packages/lib/test-utils-store-contracts) - Store backend contract test suites for Koi. Tests: 5.
- `@koi/validation` (packages/lib/validation) - Validate brick artifacts, pipelines, fitness scores, and config schemas. Tests: 16.
- `@koi/variant-selection` (packages/lib/variant-selection) - Select degenerate tool variants by context, fitness, round-robin, or failover. Tests: 6.
- `@koi/welford-stats` (packages/lib/welford-stats) - Welford's online algorithm for running mean, variance, and standard deviation. Tests: 1.
