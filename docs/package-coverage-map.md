# Package Coverage Map

Generated from active workspace packages with `bun scripts/generate-package-coverage-map.ts`.

Current snapshot:

- 223 workspace packages
- 11 package families
- 223 packages with local test files
- 199 packages with dedicated package docs

## Family Summary

| Family | Packages | Test files | Dedicated package docs |
| --- | ---: | ---: | ---: |
| drivers | 2 | 41 | 2 |
| exec | 3 | 17 | 3 |
| kernel | 4 | 126 | 0 |
| lib | 145 | 770 | 126 |
| meta | 6 | 119 | 5 |
| mm | 12 | 54 | 12 |
| net | 10 | 91 | 10 |
| sandbox | 12 | 67 | 12 |
| sched | 5 | 22 | 5 |
| security | 22 | 122 | 22 |
| ui | 2 | 57 | 2 |

## Package Inventory

Each line shows package name, package directory, package description, test-file count, and existing package doc paths.

## drivers (2)

- `@koi/browser-ext` (packages/drivers/browser-ext) - MV3 extension + native-messaging host for attaching to user's live Chrome. Tests: 37. Docs: docs/L2/browser-ext.md.
- `@koi/browser-playwright` (packages/drivers/browser-playwright) - Playwright BrowserDriver with CDP + wsEndpoint transports. Tests: 4. Docs: docs/L2/browser-playwright.md.

## exec (3)

- `@koi/code-executor` (packages/exec/code-executor) - execute_script tool — runs language-aware scripts via an injected SandboxExecutor. Tests: 5. Docs: docs/L2/code-executor.md.
- `@koi/hook-prompt` (packages/exec/hook-prompt) - Prompt hook executor — single-shot LLM verification for agent hooks. Tests: 2. Docs: docs/L2/hook-prompt.md.
- `@koi/temporal` (packages/exec/temporal) - Durable agent execution via Temporal — SpawnLedger + TaskScheduler over Temporal Workflows and Schedules. Tests: 10. Docs: docs/L2/temporal.md.

## kernel (4)

- `@koi/core` (packages/kernel/core) - Interfaces-only kernel with 7 core contracts, ECS compositional layer, and stop-gate lifecycle types. Tests: 43. Docs: -.
- `@koi/engine` (packages/kernel/engine) - Manage kernel runtime including guards, lifecycle, middleware composition, and adapters. Tests: 54. Docs: -.
- `@koi/engine-compose` (packages/kernel/engine-compose) - Middleware composition and guard factories for the Koi kernel. Tests: 7. Docs: -.
- `@koi/engine-reconcile` (packages/kernel/engine-reconcile) - Reconciliation, supervision, and process management for the Koi kernel. Tests: 22. Docs: -.

## lib (145)

- `@koi/ace-types` (packages/lib/ace-types) - Shared domain types for ACE (Adaptive Continuous Enhancement) middleware and stores. Tests: 1. Docs: -.
- `@koi/agent-discovery` (packages/lib/agent-discovery) - Runtime discovery of external coding agents (CLI, filesystem registry, MCP). Tests: 8. Docs: docs/L2/agent-discovery.md.
- `@koi/agent-monitor` (packages/lib/agent-monitor) - Adversarial agent behavior detection — 12 OWASP-ASI10 anomaly signals (pure observer middleware). Tests: 5. Docs: docs/L2/agent-monitor.md.
- `@koi/agent-procfs` (packages/lib/agent-procfs) - Virtual /proc-style filesystem for inspecting running agent state. Tests: 3. Docs: docs/L2/agent-procfs.md.
- `@koi/agent-runtime` (packages/lib/agent-runtime) - Agent definition model — built-in and custom agent loading with validation. Tests: 7. Docs: docs/L2/agent-runtime.md.
- `@koi/agent-summary` (packages/lib/agent-summary) - Structured session summaries with untrusted-cache validation and three-variant integrity envelope. Tests: 9. Docs: docs/L2/agent-summary.md.
- `@koi/artifacts` (packages/lib/artifacts) - Versioned file lifecycle for agent-created artifacts (metadata + lifecycle via @koi/blob-cas blobs). Tests: 19. Docs: docs/L2/artifacts.md.
- `@koi/artifacts-s3` (packages/lib/artifacts-s3) - S3-backed BlobStore implementation for @koi/artifacts (AWS S3 and S3-compatible stores). Tests: 3. Docs: docs/L2/artifacts-s3.md.
- `@koi/bash-ast` (packages/lib/bash-ast) - AST-based bash command analysis for permission matching. Tests: 31. Docs: docs/L2/bash-ast.md.
- `@koi/bash-classifier` (packages/lib/bash-classifier) - ARITY-based command-prefix extraction and structural dangerous-pattern registry for bash permission policy. Tests: 3. Docs: docs/L2/bash-classifier.md.
- `@koi/bash-security` (packages/lib/bash-security) - Bash command security classifiers: injection detection, path validation, and TTP-based command classification. Tests: 3. Docs: docs/L2/bash-security.md.
- `@koi/blob-cas` (packages/lib/blob-cas) - Content-addressed blob storage (SHA-256) with pluggable BlobStore interface. Tests: 3. Docs: -.
- `@koi/browser-a11y` (packages/lib/browser-a11y) - Accessibility-tree serializer + Playwright error translator (L0u). Tests: 3. Docs: docs/L2/browser-a11y.md.
- `@koi/channel-base` (packages/lib/channel-base) - Shared ChannelAdapter factory with lifecycle, capability-aware block rendering, and handler dispatch. Tests: 14. Docs: docs/L2/channel-base.md.
- `@koi/channel-cli` (packages/lib/channel-cli) - Read user input via readline, write output to stdout. Tests: 1. Docs: docs/L2/channel-cli.md.
- `@koi/channel-discord` (packages/lib/channel-discord) - Connect Discord bots via discord.js (text, slash commands, embeds, threads). Tests: 3. Docs: docs/L2/channel-discord.md.
- `@koi/channel-email` (packages/lib/channel-email) - Email channel: IMAP IDLE inbound + SMTP outbound with durable threading. Tests: 10. Docs: docs/L2/channel-email.md.
- `@koi/channel-fallback` (packages/lib/channel-fallback) - Decorator that downgrades unsupported content blocks to text for any ChannelAdapter. Tests: 1. Docs: docs/L2/channel-fallback.md.
- `@koi/channel-ide` (packages/lib/channel-ide) - IDE channel adapter — JSON-RPC frames over a duplex socket for editor plugins. Tests: 1. Docs: docs/L2/channel-ide.md.
- `@koi/channel-mobile` (packages/lib/channel-mobile) - Mobile channel adapter — WebSocket gateway with offline message queue. Tests: 1. Docs: docs/L2/channel-mobile.md.
- `@koi/channel-signal` (packages/lib/channel-signal) - Connect Signal bots via signal-cli subprocess (JSON-RPC, DMs + groups, E.164). Tests: 5. Docs: docs/L2/channel-signal.md.
- `@koi/channel-slack` (packages/lib/channel-slack) - Connect Slack bots via Socket Mode or HTTP Events API. Tests: 3. Docs: docs/L2/channel-slack.md.
- `@koi/channel-teams` (packages/lib/channel-teams) - Microsoft Teams channel: Bot Framework webhook + Adaptive Cards. Tests: 9. Docs: docs/L2/channel-teams.md.
- `@koi/channel-telegram` (packages/lib/channel-telegram) - Connect Telegram bots via grammy (polling + webhook, inline keyboards, media). Tests: 3. Docs: docs/L2/channel-telegram.md.
- `@koi/channel-voice` (packages/lib/channel-voice) - Voice channel adapter — bridges abstract STT/TTS/transport into ChannelAdapter. Tests: 1. Docs: docs/L2/channel-voice.md.
- `@koi/channel-web` (packages/lib/channel-web) - Browser/HTTP ChannelAdapter (Bun.serve WS push + REST inbound + SSE fallback). Tests: 1. Docs: docs/L2/channel-web.md.
- `@koi/channel-whatsapp` (packages/lib/channel-whatsapp) - WhatsApp channel via Meta Cloud API (HTTP webhook + Graph API). Tests: 8. Docs: docs/L2/channel-whatsapp.md.
- `@koi/checkpoint` (packages/lib/checkpoint) - End-of-turn capture middleware + CAS blob store for session-level rollback. Tests: 11. Docs: docs/L2/checkpoint.md.
- `@koi/config` (packages/lib/config) - Runtime policy configuration: Zod schemas, YAML/JSON loading, reactive store, hot-reload. Tests: 15. Docs: docs/L2/config.md.
- `@koi/context-manager` (packages/lib/context-manager) - Context window compaction policy with tiered thresholds, microcompact, and exponential backoff. Tests: 20. Docs: docs/L2/context-manager.md.
- `@koi/cost-aggregator` (packages/lib/cost-aggregator) - Real-time cost aggregation with per-model/tool/agent/provider breakdowns and budget thresholds. Tests: 7. Docs: docs/L2/cost-aggregator.md.
- `@koi/crystallize` (packages/lib/crystallize) - Pattern detection over agent turn traces — surfaces repeating tool sequences as scored forge candidates.. Tests: 4. Docs: docs/L2/crystallize.md.
- `@koi/dashboard-api` (packages/lib/dashboard-api) - Dashboard HTTP API — headless REST + SSE handler over Bun.serve, bearer-auth, cursor pagination, and query filters. Tests: 7. Docs: docs/L2/dashboard-api.md.
- `@koi/dashboard-client` (packages/lib/dashboard-client) - Typed HTTP + SSE client SDK for the Koi dashboard API. Tests: 4. Docs: docs/L2/dashboard-client.md.
- `@koi/dashboard-types` (packages/lib/dashboard-types) - Dashboard contracts: AgentStatus, SessionSummary, MetricPoint, TraceView, REST envelope, WS subscribe protocol. Tests: 1. Docs: docs/L2/dashboard-types.md.
- `@koi/debug` (packages/lib/debug) - Debug package — step-through agent execution, breakpoints, and state inspection. Tests: 4. Docs: docs/L2/debug.md.
- `@koi/decision-ledger` (packages/lib/decision-ledger) - Per-session decision ledger projection — read-only join over trajectory + audit with run report as a sidecar summary. Tests: 1. Docs: docs/L2/decision-ledger.md.
- `@koi/edit-match` (packages/lib/edit-match) - Search and replace files using cascading match strategies from exact to fuzzy. Tests: 4. Docs: -.
- `@koi/errors` (packages/lib/errors) - Provide KoiRuntimeError class, circuit breaker, retry logic, and filesystem error mapping. Tests: 7. Docs: -.
- `@koi/eval` (packages/lib/eval) - Agent eval framework: run suites, score transcripts, persist runs, detect regressions, self-test capabilities. Tests: 8. Docs: docs/L2/eval.md.
- `@koi/event-delivery` (packages/lib/event-delivery) - Manage event subscriptions with serialized delivery, retry, dead letter queue, and replay. Tests: 2. Docs: -.
- `@koi/event-trace` (packages/lib/event-trace) - ATIF trajectory recording middleware — records every model/tool call to an inspectable trajectory document. Tests: 5. Docs: docs/L2/event-trace.md.
- `@koi/execution-context` (packages/lib/execution-context) - Store and retrieve session context via AsyncLocalStorage for tool execution. Tests: 4. Docs: -.
- `@koi/federation` (packages/lib/federation) - Multi-zone agent coordination — zone registry, sequence-cursor sync, cross-zone tool routing. Tests: 6. Docs: docs/L2/federation.md.
- `@koi/file-resolution` (packages/lib/file-resolution) - Read markdown files, resolve directory structures, enforce token budgets. Tests: 7. Docs: docs/L2/file-resolution.md.
- `@koi/file-type` (packages/lib/file-type) - Magic-byte MIME detection for user-originated file content — clipboard, @-reference, upload. Tests: 1. Docs: docs/L2/file-type.md.
- `@koi/forge-demand` (packages/lib/forge-demand) - Demand-triggered forge detection: capability gaps, repeated failures, latency degradation, user corrections.. Tests: 4. Docs: docs/L2/forge-demand.md.
- `@koi/forge-exaptation` (packages/lib/forge-exaptation) - Purpose-drift detection for forge artifacts: pure functions over usage observations.. Tests: 3. Docs: docs/L2/forge-exaptation.md.
- `@koi/forge-integrity` (packages/lib/forge-integrity) - Content-addressable integrity, provenance, and lineage helpers for forged bricks. L2.. Tests: 3. Docs: docs/L2/forge-integrity.md.
- `@koi/forge-optimizer` (packages/lib/forge-optimizer) - Advisory artifact-optimization helpers: scoring, merge/simplify/retirement suggestions, lifecycle validation (L2).. Tests: 7. Docs: docs/L2/forge-optimizer.md.
- `@koi/forge-policy` (packages/lib/forge-policy) - Sync deterministic policy evaluator + audit log for forge candidates. L2.. Tests: 6. Docs: docs/L2/forge-policy.md.
- `@koi/forge-tools` (packages/lib/forge-tools) - Primordial forge tools and in-memory ForgeStore (L2). Tests: 6. Docs: docs/L2/forge-tools.md.
- `@koi/forge-types` (packages/lib/forge-types) - Shared type + contract surfaces for @koi/forge-* L2 packages. L0u types-only.. Tests: 1. Docs: docs/L2/forge-types.md.
- `@koi/forge-verifier` (packages/lib/forge-verifier) - Sequential short-circuiting verification pipeline for forge artifacts with pluggable stages and caching.. Tests: 2. Docs: docs/L2/forge-verifier.md.
- `@koi/fs-local` (packages/lib/fs-local) - Local filesystem FileSystemBackend using Bun.file/node:fs. Tests: 1. Docs: docs/L2/fs-local.md.
- `@koi/fs-nexus` (packages/lib/fs-nexus) - Nexus-backed FileSystemBackend via JSON-RPC. Tests: 8. Docs: docs/L2/fs-nexus.md.
- `@koi/fs-scoped` (packages/lib/fs-scoped) - Scoped filesystem wrapper — restricts a FileSystemBackend to a root with configurable ro/rw access. Tests: 1. Docs: -.
- `@koi/gateway-types` (packages/lib/gateway-types) - Shared gateway wire-protocol types (GatewayFrame, Session, RoutingContext). L0u — no logic, no deps beyond @koi/core.. Tests: 1. Docs: -.
- `@koi/git-utils` (packages/lib/git-utils) - Wrap git CLI commands and resolve worktree paths via Bun.spawn. Tests: 4. Docs: -.
- `@koi/handoff` (packages/lib/handoff) - Structured context relay between agents — typed envelopes + auto-injecting middleware. Tests: 9. Docs: docs/L2/handoff.md.
- `@koi/harness` (packages/lib/harness) - CLI harness assembly: wires a KoiRuntime to a ChannelAdapter for REPL and single-prompt execution. Tests: 2. Docs: docs/L2/harness.md.
- `@koi/harness-search` (packages/lib/harness-search) - Iterative refinement search over synthesized forge variants with Thompson sampling (L2). Tests: 4. Docs: docs/L2/harness-search.md.
- `@koi/harness-synth` (packages/lib/harness-synth) - LLM-driven single-candidate forge synthesis with verifier-driven retry (L2). Tests: 2. Docs: docs/L2/harness-synth.md.
- `@koi/hash` (packages/lib/hash) - Compute brick IDs, content hashes, HMACs, and ULIDs for L1 and L2 packages. Tests: 7. Docs: -.
- `@koi/hooks` (packages/lib/hooks) - Hook loader, schema validation, session-scoped hook lifecycle management, and stop-gate coordination. Tests: 20. Docs: docs/L2/hooks.md.
- `@koi/ipc-local` (packages/lib/ipc-local) - In-process mailbox IPC: in-memory MailboxComponent with microtask dispatch and MailboxRouter for multi-agent routing. Tests: 3. Docs: docs/L2/ipc-local.md.
- `@koi/ipc-nexus` (packages/lib/ipc-nexus) - Nexus-backed MailboxComponent with optional local fallback. Tests: 2. Docs: docs/L2/ipc-nexus.md.
- `@koi/long-running` (packages/lib/long-running) - Long-running harness — multi-turn agent lifecycle with soft checkpointing, pause/resume, and crash recovery. Tests: 3. Docs: docs/L2/long-running.md.
- `@koi/loop` (packages/lib/loop) - Convergence loop primitive — re-runs an agent until a deterministic verifier passes or a budget is exhausted. Tests: 8. Docs: docs/L2/loop.md.
- `@koi/lsp` (packages/lib/lsp) - LSP client tools: hover, definition, references, diagnostics, symbols. Tests: 9. Docs: docs/L2/lsp.md.
- `@koi/middleware-ace` (packages/lib/middleware-ace) - Adaptive Continuous Enhancement — trajectory-to-playbook self-improvement loop (stat pipeline + injection). Tests: 11. Docs: docs/L2/middleware-ace.md.
- `@koi/middleware-call-dedup` (packages/lib/middleware-call-dedup) - Cache deterministic tool call results within a session by content-hashed key. Tests: 3. Docs: docs/L2/middleware-call-dedup.md.
- `@koi/middleware-call-limits` (packages/lib/middleware-call-limits) - Per-session tool and model call caps with atomic increment-if-below counters. Tests: 4. Docs: docs/L2/middleware-call-limits.md.
- `@koi/middleware-circuit-breaker` (packages/lib/middleware-circuit-breaker) - Per-provider circuit breaker for model calls — fail fast on unhealthy providers. Tests: 1. Docs: docs/L2/middleware-circuit-breaker.md.
- `@koi/middleware-degenerate` (packages/lib/middleware-degenerate) - Variant selection + failover middleware for capabilities with multiple degenerate tool implementations. Tests: 1. Docs: docs/L2/middleware-degenerate.md.
- `@koi/middleware-event-rules` (packages/lib/middleware-event-rules) - Declarative YAML rules mapping engine events (tools/turns/sessions) to actions (escalate/notify/log/skip_tool). Tests: 6. Docs: docs/L2/middleware-event-rules.md.
- `@koi/middleware-feedback-loop` (packages/lib/middleware-feedback-loop) - Model output validation, structured feedback injection, and tool health tracking middleware. Tests: 7. Docs: docs/L2/middleware-feedback-loop.md.
- `@koi/middleware-fs-rollback` (packages/lib/middleware-fs-rollback) - Snapshot/restore the target file around protected tool calls (L2). Tests: 1. Docs: docs/L2/middleware-fs-rollback.md.
- `@koi/middleware-otel` (packages/lib/middleware-otel) - OpenTelemetry GenAI semantic convention middleware — emits spans for model calls, tool invocations, and agent sessions. Tests: 2. Docs: docs/L2/middleware-otel.md.
- `@koi/middleware-output-verifier` (packages/lib/middleware-output-verifier) - Two-stage output quality gate: deterministic checks + optional LLM-as-judge with revise loop and streaming. Tests: 3. Docs: docs/L2/middleware-output-verifier.md.
- `@koi/middleware-plan-persist` (packages/lib/middleware-plan-persist) - File-backed persistence for write_plan — saves plans to .koi/plans/<ts>-<slug>.md and loads them back. Tests: 5. Docs: docs/L2/middleware-plan-persist.md.
- `@koi/middleware-planning` (packages/lib/middleware-planning) - Planning middleware — injects write_plan tool for structured multi-step task tracking. Tests: 1. Docs: docs/L2/middleware-planning.md.
- `@koi/middleware-policy-cache` (packages/lib/middleware-policy-cache) - Short-circuit tool calls for forge-verified bricks promoted to policy mode. Tests: 1. Docs: docs/L2/middleware-policy-cache.md.
- `@koi/middleware-prompt-cache` (packages/lib/middleware-prompt-cache) - Reorder messages for cache-friendly prefix; emit CacheHints for engine adapters. Tests: 2. Docs: docs/L2/middleware-prompt-cache.md.
- `@koi/middleware-reflex` (packages/lib/middleware-reflex) - Rule-based short-circuit middleware — canned responses for known message patterns, skipping the model. Tests: 1. Docs: docs/L2/middleware-reflex.md.
- `@koi/middleware-report` (packages/lib/middleware-report) - Activity reporting middleware with bounded ring buffer and structured run reports. Tests: 4. Docs: docs/L2/middleware-report.md.
- `@koi/middleware-rlm` (packages/lib/middleware-rlm) - Segment oversized model requests into chunks and reassemble responses. Tests: 4. Docs: docs/L2/middleware-rlm.md.
- `@koi/middleware-semantic-retry` (packages/lib/middleware-semantic-retry) - Context-aware prompt rewriting on agent failure with pluggable failure analysis and retry actions. Tests: 3. Docs: docs/L2/middleware-semantic-retry.md.
- `@koi/middleware-strict-agentic` (packages/lib/middleware-strict-agentic) - Stop-gate middleware that blocks premature completion on filler/plan-only turns in agentic mode. Tests: 5. Docs: docs/L2/middleware-strict-agentic.md.
- `@koi/middleware-task-anchor` (packages/lib/middleware-task-anchor) - Injects a system-reminder with the live task board after K idle turns. Tests: 3. Docs: docs/L2/middleware-task-anchor.md.
- `@koi/middleware-tool-audit` (packages/lib/middleware-tool-audit) - Tool usage tracking and lifecycle signals (unused, low adoption, high failure, high value). Tests: 3. Docs: docs/L2/middleware-tool-audit.md.
- `@koi/middleware-tool-disclosure` (packages/lib/middleware-tool-disclosure) - Progressive tool disclosure: swap full descriptors for summaries above a threshold; promote on demand. Tests: 2. Docs: docs/L2/middleware-tool-disclosure.md.
- `@koi/middleware-tool-error-formatter` (packages/lib/middleware-tool-error-formatter) - Format tool errors into actionable model feedback with pluggable formatters. Tests: 1. Docs: docs/L2/middleware-tool-error-formatter.md.
- `@koi/middleware-tool-recovery` (packages/lib/middleware-tool-recovery) - Recover structured tool calls from text patterns in model responses (Hermes / Llama 3.1 / JSON fence). Tests: 4. Docs: docs/L2/middleware-tool-recovery.md.
- `@koi/middleware-tool-selector` (packages/lib/middleware-tool-selector) - Pre-filter tools before model calls — reduces token usage and improves selection accuracy. Tests: 4. Docs: docs/L2/middleware-tool-selector.md.
- `@koi/middleware-turn-ack` (packages/lib/middleware-turn-ack) - Two-stage turn acknowledgement — debounced 'processing' + 'idle' status via channel.sendStatus. Tests: 1. Docs: docs/L2/middleware-turn-ack.md.
- `@koi/middleware-turn-prelude` (packages/lib/middleware-turn-prelude) - Injects reactive background-task match notifications as user-role prelude before each model turn. Tests: 4. Docs: docs/L2/middleware-turn-prelude.md.
- `@koi/middleware-user-model` (packages/lib/middleware-user-model) - Unified user-model middleware: pre/post-action channels + sensor enrichment fused into one [User Context] block. Tests: 4. Docs: docs/L2/middleware-user-model.md.
- `@koi/model-registry` (packages/lib/model-registry) - Per-model context window registry and resolution utilities for L1 and L2 packages. Tests: 1. Docs: -.
- `@koi/model-router` (packages/lib/model-router) - Multi-provider LLM routing with ordered fallback, circuit breakers, and latency health monitoring. Tests: 7. Docs: docs/L2/model-router.md.
- `@koi/nexus-client` (packages/lib/nexus-client) - Shared JSON-RPC 2.0 HTTP transport for Nexus server communication. Tests: 4. Docs: docs/L2/nexus-client.md.
- `@koi/outcome-evaluator` (packages/lib/outcome-evaluator) - LLM-as-judge rubric evaluator: grades agent output per criterion, re-prompts until criteria pass or budget is exhausted. Tests: 4. Docs: docs/L2/outcome-evaluator.md.
- `@koi/playbook-store-nexus` (packages/lib/playbook-store-nexus) - L2 storage adapter: ACE PlaybookStore/StructuredPlaybookStore/TrajectoryStore/PlaybookProposalStore over Nexus. Tests: 5. Docs: docs/L2/playbook-store-nexus.md.
- `@koi/playbook-store-sqlite` (packages/lib/playbook-store-sqlite) - L2 storage adapter: persistent ACE PlaybookStore + TrajectoryStore + PlaybookProposalStore over SQLite. Tests: 1. Docs: docs/L2/playbook-store-sqlite.md.
- `@koi/plugins` (packages/lib/plugins) - Plugin manifest validation, multi-source discovery, and in-memory registry. Tests: 7. Docs: docs/L2/plugins.md.
- `@koi/proactive` (packages/lib/proactive) - Proactive/autonomous tool surfaces — sleep, wake, and cron tools over SchedulerComponent. Tests: 27. Docs: docs/L2/proactive.md.
- `@koi/query-engine` (packages/lib/query-engine) - Stream consumer that maps ModelChunk to EngineEvent with tool-call argument accumulation. Tests: 6. Docs: docs/L2/query-engine.md.
- `@koi/replay` (packages/lib/replay) - Deterministic cassette recording and replay for Koi agent tests. Tests: 3. Docs: docs/L2/replay.md.
- `@koi/rules-loader` (packages/lib/rules-loader) - Hierarchical project rules file discovery, loading, merging, and system prompt injection. Tests: 6. Docs: docs/L2/rules-loader.md.
- `@koi/sandbox-cloud-base` (packages/lib/sandbox-cloud-base) - Shared bridge and hosted-sandbox helpers for cloud-backed execution. Tests: 5. Docs: -.
- `@koi/scratchpad-conformance` (packages/lib/scratchpad-conformance) - Shared bun:test conformance suite for ScratchpadComponent implementations. Tests: 1. Docs: docs/L2/scratchpad-conformance.md.
- `@koi/scratchpad-local` (packages/lib/scratchpad-local) - In-memory ScratchpadComponent with CAS, TTL, and glob filtering. Tests: 2. Docs: docs/L2/scratchpad-local.md.
- `@koi/scratchpad-nexus` (packages/lib/scratchpad-nexus) - Nexus-backed ScratchpadComponent with optional local fallback. Tests: 4. Docs: docs/L2/scratchpad-nexus.md.
- `@koi/search-nexus` (packages/lib/search-nexus) - Nexus-backed SearchBackend — Retriever + Indexer via Nexus search RPC. Tests: 3. Docs: docs/L2/search-nexus.md.
- `@koi/secure-storage` (packages/lib/secure-storage) - OS keychain token storage with file-based locking for concurrent access. Tests: 3. Docs: -.
- `@koi/session` (packages/lib/session) - Session persistence (SQLite/WAL) and transcript (append-only JSONL) for crash recovery. Tests: 9. Docs: docs/L2/session.md.
- `@koi/settings` (packages/lib/settings) - Hierarchical settings cascade: user → project → local → flag → policy. Tests: 4. Docs: docs/L2/settings.md.
- `@koi/shutdown` (packages/lib/shutdown) - Handle graceful shutdown signals and map exit codes for CLI and deploy. Tests: 3. Docs: -.
- `@koi/skill-distiller` (packages/lib/skill-distiller) - Distill reusable skill drafts from successful task traces with content-hash dedupe and provenance audit. Tests: 12. Docs: docs/L2/skill-distiller.md.
- `@koi/skill-tool` (packages/lib/skill-tool) - SkillTool meta-tool — on-demand skill loading, advertising, and fork dispatch. Tests: 4. Docs: docs/L2/skill-tool.md.
- `@koi/skills-runtime` (packages/lib/skills-runtime) - Multi-source skill discovery and loading for Koi agents. Tests: 15. Docs: docs/L2/skills-runtime.md.
- `@koi/snapshot-store-nexus` (packages/lib/snapshot-store-nexus) - L2 storage adapter: SnapshotChainStore<T> over Nexus JSON-RPC. Tests: 4. Docs: docs/L2/snapshot-store-nexus.md.
- `@koi/snapshot-store-sqlite` (packages/lib/snapshot-store-sqlite) - L2 storage adapter: SnapshotChainStore<T> over SQLite with recursive-CTE walks and mark-sweep GC. Tests: 5. Docs: docs/L2/snapshot-store-sqlite.md.
- `@koi/spawn-tools` (packages/lib/spawn-tools) - LLM-callable agent spawn tool + TaskCascade helper for coordinator orchestration (L2). Tests: 6. Docs: docs/L2/spawn-tools.md.
- `@koi/task-board` (packages/lib/task-board) - Immutable TaskBoard with DAG validation, cycle detection, and topological sort. Tests: 3. Docs: -.
- `@koi/task-spawn` (packages/lib/task-spawn) - Lightweight task tool for zero-friction subagent spawning + copilot routing. Tests: 8. Docs: docs/L2/task-spawn.md.
- `@koi/task-tools` (packages/lib/task-tools) - LLM-callable task management tools — create, get, update, list, stop, output (L2). Tests: 2. Docs: docs/L2/task-tools.md.
- `@koi/tasks` (packages/lib/tasks) - Pluggable task board persistence — in-memory and file-based backends. Tests: 12. Docs: docs/L2/tasks.md.
- `@koi/team-runtime` (packages/lib/team-runtime) - Parallel multi-agent team orchestration with event replay, dependency-aware scheduling, and resource locking. Tests: 9. Docs: docs/L2/team-runtime.md.
- `@koi/test` (packages/lib/test) - Test doubles, context factories, event collectors, and assertion helpers for Koi agent tests. Tests: 11. Docs: -.
- `@koi/tool-browser` (packages/lib/tool-browser) - Browser automation tools via accessibility-tree-first BrowserDriver. Tests: 20. Docs: docs/L2/tool-browser.md.
- `@koi/tool-exec` (packages/lib/tool-exec) - execute_code: runs model scripts via Koi tools in an isolated Bun Worker, returning only the final result (L2). Tests: 3. Docs: docs/L2/tool-exec.md.
- `@koi/tool-notebook` (packages/lib/tool-notebook) - Built-in notebook tool: read and edit .ipynb cells. Tests: 6. Docs: docs/L2/tool-notebook.md.
- `@koi/tools-bash` (packages/lib/tools-bash) - Bash shell execution tool with security classifiers. Tests: 4. Docs: docs/L2/tools-bash.md.
- `@koi/tools-builtin` (packages/lib/tools-builtin) - Built-in tools: filesystem (read, edit, write) + search (glob, grep, tool-search). Tests: 4. Docs: docs/L2/tools-builtin.md.
- `@koi/tools-core` (packages/lib/tools-core) - Tool type bridge, registry, and ComponentProvider adapter. Tests: 3. Docs: docs/L2/tools-core.md.
- `@koi/tools-web` (packages/lib/tools-web) - Fetch and search the web with SSRF protection and result caching. Tests: 7. Docs: docs/L2/tools-web.md.
- `@koi/toolsets` (packages/lib/toolsets) - Named composable tool presets — reusable tool groups for agents, spawn, and channels. Tests: 1. Docs: docs/L2/toolsets.md.
- `@koi/url-safety` (packages/lib/url-safety) - SSRF / private-IP / metadata-endpoint blocklist for outbound HTTP — shared safe-fetch utility. Tests: 5. Docs: -.
- `@koi/validation` (packages/lib/validation) - Validate brick artifacts, pipelines, fitness scores, and config schemas. Tests: 17. Docs: -.
- `@koi/variant-selection` (packages/lib/variant-selection) - Selection strategies for degenerate tool/brick variants. L0u utility package.. Tests: 7. Docs: -.
- `@koi/watch-patterns` (packages/lib/watch-patterns) - Linear-time regex matcher, line buffer, and pending-match store for reactive shell notifications. Tests: 5. Docs: docs/L2/watch-patterns.md.
- `@koi/workspace` (packages/lib/workspace) - Git worktree WorkspaceBackend and ComponentProvider for agent isolation. Tests: 3. Docs: docs/L2/workspace.md.
- `@koi/workspace-conformance` (packages/lib/workspace-conformance) - Shared bun:test conformance suite for WorkspaceBackend implementations. Tests: 1. Docs: docs/L2/workspace-conformance.md.
- `@koi/workspace-nexus` (packages/lib/workspace-nexus) - Nexus-backed WorkspaceBackend with optional local fallback. Tests: 4. Docs: docs/L2/workspace-nexus.md.

## meta (6)

- `@koi-agent/cli` (packages/meta/cli) - Interactive command-line interface for agent initialization and local execution. Tests: 68. Docs: docs/L3/cli.md.
- `@koi/auto-harness` (packages/meta/auto-harness) - L3 composition wiring for auto-harness synthesis session controls and policy-cache attachment. Tests: 1. Docs: -.
- `@koi/autonomous` (packages/meta/autonomous) - L3 autonomous composition facade for long-running harness, scheduler, and task-aware helper wiring. Tests: 1. Docs: docs/L2/autonomous.md, docs/L3/autonomous.md.
- `@koi/nexus` (packages/meta/nexus) - L3 Nexus composition wiring for the active v2 Nexus package set. Tests: 6. Docs: docs/L3/nexus.md.
- `@koi/rlm-stack` (packages/meta/rlm-stack) - L3 composition wiring @koi/middleware-rlm with @koi/context-manager threshold coordination. Tests: 3. Docs: docs/L2/rlm-stack.md, docs/L3/rlm-stack.md.
- `@koi/runtime` (packages/meta/runtime) - L3 meta-package: wires Phase 1 kernel + L2 packages into a bootable runtime with progressive stub replacement. Tests: 40. Docs: docs/L3/runtime.md.

## mm (12)

- `@koi/dream` (packages/mm/dream) - Dream consolidation — offline memory merging, pruning, and upgrade. Tests: 3. Docs: docs/L2/dream.md.
- `@koi/memory` (packages/mm/memory) - Session-start memory recall — scan, score, budget, and format persisted memories. Tests: 4. Docs: docs/L2/memory.md.
- `@koi/memory-fs` (packages/mm/memory-fs) - File-based memory storage with CRUD, MEMORY.md indexing, and Jaccard deduplication. Tests: 8. Docs: docs/L2/memory-fs.md.
- `@koi/memory-team-sync` (packages/mm/memory-team-sync) - Team memory sync — type filtering, secret scanning, and fail-closed sync boundary. Tests: 2. Docs: docs/L2/memory-team-sync.md.
- `@koi/memory-tools` (packages/mm/memory-tools) - Memory tools for LLM agent execution — store, recall, search, delete. Tests: 8. Docs: docs/L2/memory-tools.md.
- `@koi/middleware-collective-memory` (packages/mm/middleware-collective-memory) - Cross-spawn learning injection — extracts and injects collective memory from brick artifacts. Tests: 6. Docs: docs/L2/middleware-collective-memory.md.
- `@koi/middleware-dream` (packages/mm/middleware-dream) - Dream consolidation middleware — fires memory consolidation in the background after session end. Tests: 2. Docs: docs/L2/middleware-dream.md.
- `@koi/middleware-extraction` (packages/mm/middleware-extraction) - Post-turn learning extraction middleware — extracts reusable knowledge from agent tool outputs. Tests: 4. Docs: docs/L2/middleware-extraction.md.
- `@koi/middleware-memory-recall` (packages/mm/middleware-memory-recall) - Frozen-snapshot memory recall middleware — injects recalled memories at session start. Tests: 2. Docs: docs/L2/middleware-memory-recall.md.
- `@koi/model-openai-compat` (packages/mm/model-openai-compat) - Thin OpenAI-compatible model adapter for OpenAI-compatible and other Chat Completions APIs. Tests: 10. Docs: docs/L2/model-openai-compat.md.
- `@koi/session-repair` (packages/mm/session-repair) - Validate and repair message history through orphan repair, dedup, and merge phases. Tests: 3. Docs: docs/L2/session-repair.md.
- `@koi/token-estimator` (packages/mm/token-estimator) - Estimate tokens using configurable heuristics (default: 4 chars per token). Tests: 2. Docs: docs/L2/token-estimator.md.

## net (10)

- `@koi/daemon` (packages/net/daemon) - OS-process supervisor and worker backends (subprocess) for long-running agent workers. Tests: 15. Docs: docs/L2/daemon.md.
- `@koi/gateway` (packages/net/gateway) - WebSocket gateway core — routing, auth, sequencing, backpressure (v2 minimal, no node registry or tool routing). Tests: 9. Docs: docs/L2/gateway.md.
- `@koi/gateway-canvas` (packages/net/gateway-canvas) - Canvas HTTP server: surface CRUD with ETag CAS and SSE streaming for real-time agent-rendered content. Tests: 3. Docs: docs/L2/gateway-canvas.md.
- `@koi/gateway-http` (packages/net/gateway-http) - Production HTTP/WS gateway: HMAC auth, replay/idempotency, rate limits, CORS, audit log, graceful shutdown. Tests: 22. Docs: docs/L2/gateway-http.md.
- `@koi/gateway-nexus` (packages/net/gateway-nexus) - Nexus-backed SessionStore for HA gateway: write-through cache, coalesced async writes, degradation state machine. Tests: 4. Docs: docs/L2/gateway-nexus.md.
- `@koi/gateway-stack` (packages/net/gateway-stack) - L3 gateway stack: wires gateway + canvas + webhook + optional Nexus HA into one lifecycle plus health endpoint. Tests: 2. Docs: docs/L3/gateway-stack.md.
- `@koi/gateway-webhook` (packages/net/gateway-webhook) - Webhook HTTP ingestion — POST requests to GatewayFrames with signature verification and idempotency.. Tests: 4. Docs: docs/L2/gateway-webhook.md.
- `@koi/mcp` (packages/net/mcp) - MCP transport layer, connection lifecycle, and state management. Tests: 25. Docs: docs/L2/mcp.md.
- `@koi/mcp-server` (packages/net/mcp-server) - Expose agent tools and platform capabilities via Model Context Protocol. Tests: 3. Docs: docs/L2/mcp-server.md.
- `@koi/nexus-sandbox` (packages/net/nexus-sandbox) - Spawn local nexus-ai-fs[sandbox] subprocess: zero external services, SQLite + LRU + BM25S. Tests: 4. Docs: docs/L2/nexus-sandbox.md.

## sandbox (12)

- `@koi/sandbox-cloudflare` (packages/sandbox/sandbox-cloudflare) - Cloudflare Workers EdgeFunctionAdapter — durable per-(ownerId, operationId) dedupe via Durable Objects. Tests: 11. Docs: docs/L2/sandbox-cloudflare.md.
- `@koi/sandbox-conformance` (packages/sandbox/sandbox-conformance) - Shared bun:test conformance suite for SandboxAdapter implementations. Tests: 5. Docs: docs/L2/sandbox-conformance.md.
- `@koi/sandbox-daytona` (packages/sandbox/sandbox-daytona) - Daytona hosted-cloud SandboxAdapter for managed workspace execution. Tests: 3. Docs: docs/L2/sandbox-daytona.md.
- `@koi/sandbox-docker` (packages/sandbox/sandbox-docker) - Docker-backed SandboxAdapter for containerized command execution. Tests: 12. Docs: docs/L2/sandbox-docker.md.
- `@koi/sandbox-e2b` (packages/sandbox/sandbox-e2b) - E2B hosted-cloud SandboxAdapter for remote microVM execution. Tests: 4. Docs: docs/L2/sandbox-e2b.md.
- `@koi/sandbox-executor` (packages/sandbox/sandbox-executor) - Subprocess-backed SandboxExecutor for isolated code execution. Tests: 2. Docs: docs/L2/sandbox-executor.md.
- `@koi/sandbox-ipc` (packages/sandbox/sandbox-ipc) - Structured host-worker IPC bridge for sandboxed code execution. Tests: 6. Docs: docs/L2/sandbox-ipc.md.
- `@koi/sandbox-os` (packages/sandbox/sandbox-os) - OS-level sandbox adapter with seatbelt and bubblewrap backends. Tests: 8. Docs: docs/L2/sandbox-os.md.
- `@koi/sandbox-router` (packages/sandbox/sandbox-router) - Capability-based selection over SandboxAdapter instances with create-time fallback and lifecycle tracking. Tests: 3. Docs: docs/L2/sandbox-router.md.
- `@koi/sandbox-ssh` (packages/sandbox/sandbox-ssh) - SSH-backed SandboxAdapter for remote command execution via ssh2. Tests: 3. Docs: docs/L2/sandbox-ssh.md.
- `@koi/sandbox-vercel` (packages/sandbox/sandbox-vercel) - Vercel Functions EdgeFunctionAdapter (DESIGN-ONLY in v1) — KV-backed dedupe per (ownerId, operationId).. Tests: 7. Docs: docs/L2/sandbox-vercel.md.
- `@koi/sandbox-wasm` (packages/sandbox/sandbox-wasm) - In-process WebAssembly executor (package-local WasmExecutor contract; NOT SandboxExecutor). Tests: 3. Docs: docs/L2/sandbox-wasm.md.

## sched (5)

- `@koi/harness-scheduler` (packages/sched/harness-scheduler) - Auto-resume scheduler for suspended harnesses. Tests: 2. Docs: docs/L2/harness-scheduler.md.
- `@koi/scheduler` (packages/sched/scheduler) - Task scheduler with cron, priority queue, retry, and SQLite persistence. Tests: 8. Docs: docs/L2/scheduler.md.
- `@koi/scheduler-nexus` (packages/sched/scheduler-nexus) - Nexus-backed distributed task store, schedule store, and priority queue for cross-node scheduling. Tests: 6. Docs: docs/L2/scheduler-nexus.md.
- `@koi/scheduler-provider` (packages/sched/scheduler-provider) - Agent-facing tools for scheduler interaction (9 tools via SchedulerComponent). Tests: 1. Docs: docs/L2/scheduler-provider.md.
- `@koi/verified-loop` (packages/sched/verified-loop) - External verification loop — iterate agent against objective gates instead of LLM self-assessment. Tests: 5. Docs: docs/L2/verified-loop.md.

## security (22)

- `@koi/approval-zones` (packages/security/approval-zones) - Approval zones with risk scoring — converts ask verdicts into auto / sandbox-then-auto / ask. Tests: 6. Docs: docs/L2/approval-zones.md.
- `@koi/audit-sink-ndjson` (packages/security/audit-sink-ndjson) - Buffered NDJSON file sink for @koi/middleware-audit. Tests: 1. Docs: docs/L2/audit-sink-ndjson.md.
- `@koi/audit-sink-nexus` (packages/security/audit-sink-nexus) - Nexus-backed AuditSink — batched writes with interval and size triggers. Tests: 2. Docs: docs/L2/audit-sink-nexus.md.
- `@koi/audit-sink-sqlite` (packages/security/audit-sink-sqlite) - SQLite sink with WAL mode and time+kind index for @koi/middleware-audit. Tests: 1. Docs: docs/L2/audit-sink-sqlite.md.
- `@koi/governance-approval-tiers` (packages/security/governance-approval-tiers) - Persistent approval allowlist (JSON-lines) with scope tiers, aliasing, and delta audit. Tests: 7. Docs: docs/L2/governance-approval-tiers.md.
- `@koi/governance-core` (packages/security/governance-core) - Governance middleware bundle — policy gate, setpoint enforcement, cost recording. Tests: 8. Docs: docs/L2/governance-core.md.
- `@koi/governance-defaults` (packages/security/governance-defaults) - Out-of-box GovernanceController + GovernanceBackend + pricing defaults for @koi/governance-core. Tests: 5. Docs: docs/L2/governance-defaults.md.
- `@koi/governance-delegation` (packages/security/governance-delegation) - Capability tokens + delegation chains. L2 verifier, signer, and in-memory revocation registry over @koi/core.. Tests: 10. Docs: docs/L2/governance-delegation.md.
- `@koi/governance-scope` (packages/security/governance-scope) - Capability-attenuation wrappers: scoped filesystem, fetcher, and credentials (glob/URLPattern/key allowlists). Tests: 5. Docs: docs/L2/governance-scope.md.
- `@koi/governance-security` (packages/security/governance-security) - Security analysis helpers — injection detection, PII finders, anomaly monitor, security scorer. Tests: 5. Docs: docs/L2/governance-security.md.
- `@koi/middleware-audit` (packages/security/middleware-audit) - Security-grade audit logging middleware with hash chain tamper-detection, Ed25519 signing, and bounded backpressure. Tests: 4. Docs: docs/L2/middleware-audit.md.
- `@koi/middleware-exfiltration-guard` (packages/security/middleware-exfiltration-guard) - Scan tool inputs and model output for secret exfiltration (base64/URL-encoded secrets). Tests: 2. Docs: docs/L2/middleware-exfiltration-guard.md.
- `@koi/middleware-intent-capsule` (packages/security/middleware-intent-capsule) - Cryptographic mandate binding middleware — Ed25519 session signing for OWASP ASI01 goal-hijack defense. Tests: 2. Docs: docs/L2/middleware-intent-capsule.md.
- `@koi/middleware-permissions` (packages/security/middleware-permissions) - Tool-level access control middleware with pattern-based classifier, denial tracking, and human-in-the-loop approval. Tests: 15. Docs: docs/L2/middleware-permissions.md.
- `@koi/nexus-delegation` (packages/security/nexus-delegation) - Nexus-backed DelegationComponent: per-child API key grant/revoke over Nexus REST. L2.. Tests: 6. Docs: docs/L2/nexus-delegation.md.
- `@koi/permission-escalation-nexus` (packages/security/permission-escalation-nexus) - Nexus-backed coordinator-to-worker permission escalation transport. Tests: 5. Docs: docs/L2/permission-escalation-nexus.md.
- `@koi/permissions` (packages/security/permissions) - Rule-based tool access control implementing PermissionBackend. Tests: 7. Docs: docs/L2/permissions.md.
- `@koi/permissions-nexus` (packages/security/permissions-nexus) - Nexus-backed permission persistence, cross-node sync, and delegation hooks. Tests: 4. Docs: docs/L2/permissions-nexus.md.
- `@koi/redaction` (packages/security/redaction) - Mask secrets (API keys, credentials, tokens) in logs with 13 built-in pattern detectors. Tests: 13. Docs: docs/L2/redaction.md.
- `@koi/registry-nexus` (packages/security/registry-nexus) - Nexus-backed AgentRegistry — distributed agent discovery with CAS transitions and polling projection. Tests: 4. Docs: docs/L2/registry-nexus.md.
- `@koi/skill-scanner` (packages/security/skill-scanner) - AST-based security scanner for SKILL.md files. Tests: 7. Docs: docs/L2/skill-scanner.md.
- `@koi/violation-store-sqlite` (packages/security/violation-store-sqlite) - Append-only SQLite-backed ViolationStore with WAL mode and indexed queries. Tests: 3. Docs: docs/L2/violation-store-sqlite.md.

## ui (2)

- `@koi/dashboard-ui` (packages/ui/dashboard-ui) - Minimal React + Vite scaffold for the Koi dashboard UI. Tests: 3. Docs: docs/L2/dashboard-ui.md.
- `@koi/tui` (packages/ui/tui) - OpenTUI-based terminal UI for Koi agent conversations. Tests: 54. Docs: docs/L2/tui.md.
