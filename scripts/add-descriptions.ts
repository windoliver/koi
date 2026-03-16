#!/usr/bin/env bun
/**
 * One-time script — adds `description` fields to all workspace package.json files.
 *
 * Reads each package.json, inserts `description` immediately after `name`,
 * and writes back with consistent formatting.
 *
 * Usage:
 *   bun scripts/add-descriptions.ts            # apply descriptions
 *   bun scripts/add-descriptions.ts --dry-run  # preview without writing
 */

const ROOT = new URL("../", import.meta.url).pathname;

/**
 * Canonical description lookup. Every workspace package must have an entry.
 * Format: verb-first active voice, ≤120 characters, no "A " or "The " prefix.
 */
const DESCRIPTIONS: Readonly<Record<string, string>> = {
  // ── Root / E2E / Recipe ──────────────────────────────────────────────
  koi: "Koi monorepo: self-extending agent engine with layered architecture, middleware, and governance",
  "@koi/e2e-contracts":
    "End-to-end contract validation against real LLM APIs (Anthropic, OpenAI) with E2E opt-in",
  "@koi/recipe-codex-mcp":
    "Run OpenAI Codex as governed MCP tool server in Koi agents via zero-code YAML declaration",

  // ── Kernel (L0/L1) ──────────────────────────────────────────────────
  "@koi/bootstrap":
    "Resolve .koi/{INSTRUCTIONS,TOOLS,CONTEXT}.md files for agent bootstrap context",
  "@koi/config":
    "Provide runtime policy configuration with hot-reload, validation, and engine integration",
  "@koi/core": "Define interfaces-only kernel with 7 core contracts and ECS compositional layer",
  "@koi/engine":
    "Manage kernel runtime including guards, lifecycle, middleware composition, and adapters",
  "@koi/manifest": "Load and validate YAML agent definitions with environment interpolation",
  "@koi/soul":
    "Inject unified agent personality through system prompts across soul, identity, and user layers",

  // ── Lib (L0u utilities) ──────────────────────────────────────────────
  "@koi/crypto-utils": "Generate Ed25519 keys, sign and verify messages, compute SHA-256 hashes",
  "@koi/edit-match":
    "Search and replace files using cascading match strategies from exact to fuzzy",
  "@koi/errors":
    "Provide KoiRuntimeError class, circuit breaker, retry logic, and filesystem error mapping",
  "@koi/event-delivery":
    "Manage event subscriptions with serialized delivery, retry, dead letter queue, and replay",
  "@koi/execution-context":
    "Store and retrieve session context via AsyncLocalStorage for tool execution",
  "@koi/file-resolution":
    "Read markdown files, resolve directory structures, enforce token budgets",
  "@koi/git-utils": "Wrap git CLI commands and resolve worktree paths via Bun.spawn",
  "@koi/hash": "Compute brick IDs, content hashes, HMACs, and ULIDs for L1 and L2 packages",
  "@koi/nexus-client": "Provide JSON-RPC 2.0 transport and path builders for Nexus services",
  "@koi/shutdown": "Handle graceful shutdown signals and map exit codes for CLI and deploy",
  "@koi/sqlite-utils": "Wrap SQLite operations, map errors, open databases with optimized PRAGMAs",
  "@koi/test-utils": "Provide mock agents, contract test suites, and spy utilities for testing",
  "@koi/validation": "Validate brick artifacts, pipelines, fitness scores, and config schemas",
  "@koi/variant-selection":
    "Select degenerate tool variants by context, fitness, round-robin, or failover",

  // ── Drivers ──────────────────────────────────────────────────────────
  "@koi/browser-playwright":
    "Implement Playwright-based browser driver with accessibility tree serialization and stealth initialization",
  "@koi/engine-acp":
    "Orchestrate ACP-compatible coding agents as Koi backends via JSON-RPC over stdin/stdout",
  "@koi/engine-claude":
    "Delegate to Claude Agent SDK query() with in-process MCP bridge for Koi tool execution",
  "@koi/engine-external":
    "Wrap any external process as engine adapter with single-shot, long-lived, and PTY modes",
  "@koi/engine-loop":
    "Execute pure TypeScript ReAct loop with parallel tool calls and iterative Reason+Act cycles",
  "@koi/engine-pi": "Wrap pi-agent-core with full middleware interposition on model and tool calls",
  "@koi/middleware-rlm":
    "Virtualize unbounded input as middleware — any engine can process inputs larger than context window",
  "@koi/model-router":
    "Route model calls across multiple LLM providers with retry, fallback, cascade, and circuit breaker",

  // ── FS (storage, tools, search) ──────────────────────────────────────
  "@koi/catalog":
    "Search bundled packages, forged bricks, MCP tools, and skill registry entries via unified discovery",
  "@koi/code-mode":
    "Propose and apply atomic code plans through a two-phase workflow with filesystem validation",
  "@koi/events-memory":
    "Store events in memory with replay, named subscriptions, and dead letter queue capability",
  "@koi/events-sqlite":
    "Persist durable events using SQLite with WAL mode, crash recovery, and TTL-based eviction",
  "@koi/filesystem":
    "Expose filesystem backend operations as discoverable Tool components across all engines",
  "@koi/lsp":
    "Bridge any LSP server (TypeScript, Python, Go, Rust, etc.) into Koi's ECS tool system",
  "@koi/nexus-store":
    "Consolidate Nexus-backed persistence adapters for forge, events, snapshots, sessions, and memory",
  "@koi/pay-local":
    "Track credits with fully-functional in-memory ledger and optional SQLite persistence",
  "@koi/pay-nexus": "Persist credits to Nexus via TigerBeetle + PostgreSQL payment ledger backend",
  "@koi/registry-event-sourced": "Derive agent state from event stream as single source of truth",
  "@koi/registry-http": "Read skill registry via REST with LRU + TTL cache; fail-open search",
  "@koi/registry-nexus":
    "Keep agent state in sync with Nexus via periodic polling projection cache",
  "@koi/registry-store":
    "Store bricks, skills, and versions in SQLite with FTS5 search and keyset pagination",
  "@koi/resolve":
    "Auto-resolve koi.yaml manifest to runtime instances via BrickDescriptor registry",
  "@koi/search": "Provide pluggable BM25 (keyword), vector (semantic), and hybrid search backends",
  "@koi/search-brave":
    "Query Brave Search API via SearchProvider contract for manifest auto-resolution",
  "@koi/search-nexus": "Plug Nexus search API v2 as backend for @koi/search hybrid retrieval",
  "@koi/search-provider":
    "Define contracts for web search, index search, embedders, indexers, and retrievers",
  "@koi/skill-scanner":
    "Detect malicious code in Koi forge via AST analysis with built-in rule library",
  "@koi/skills": "Parse SKILL.md files with 3-level progressive loading to minimize context usage",
  "@koi/store-fs":
    "Hash-sharded filesystem storage with hybrid metadata indexing and 4-tier overlay",
  "@koi/store-sqlite":
    "Persist bricks to SQLite with WAL mode and parameterized STRICT table schema",
  "@koi/tool-ask-guide":
    "Query knowledge sources within token budget and return results for guidance",
  "@koi/tool-ask-user": "Elicit structured responses (multi-choice or free-text) mid-execution",
  "@koi/tool-browser":
    "Automate browser via accessibility tree snapshots (100x cheaper than screenshots)",
  "@koi/tool-exec":
    "Execute ephemeral code in sandbox with input validation and timeout enforcement",
  "@koi/tools-github": "Manage PR lifecycle (create, review, merge) and CI waits via GitHub CLI",
  "@koi/tools-context-hub": "Search and fetch curated API docs from Context Hub CDN",
  "@koi/tools-web": "Fetch and search the web with SSRF protection and result caching",

  // ── Net (channels, gateway, MCP) ─────────────────────────────────────
  "@koi/acp-protocol":
    "Define ACP wire types, JSON-RPC parser, transport interface, and content/event mapping",
  "@koi/acp": "Serve agent via IDE Agent Client Protocol (ACP v0.10.x) over stdin/stdout",
  "@koi/canvas": "Implement A2UI v0.9 headless protocol for agent-generated visual workspaces",
  "@koi/channel-base":
    "Build ChannelAdapters with lifecycle, capability-aware rendering, and retry handling",
  "@koi/channel-canvas-fallback": "Replace A2UI blocks with text links for text-only channels",
  "@koi/channel-chat-sdk":
    "Wrap Slack, Discord, Teams, Google Chat, GitHub, Linear into unified adapters",
  "@koi/channel-cli": "Read user input via readline, write output to stdout",
  "@koi/channel-discord": "Connect Discord bots with text, voice, buttons, and embeds",
  "@koi/channel-email": "Receive email via IMAP IDLE and send via SMTP",
  "@koi/channel-matrix": "Connect Matrix homeservers with auto-join and debouncing",
  "@koi/channel-mobile": "Serve native mobile apps via WebSocket with JSON frames",
  "@koi/channel-signal": "Communicate via signal-cli JSON-RPC subprocess",
  "@koi/channel-slack": "Connect Slack bots via Socket Mode or HTTP Events API",
  "@koi/channel-teams": "Connect Microsoft Teams bots via Bot Framework HTTP webhooks",
  "@koi/channel-telegram": "Connect Telegram bots with polling or webhook deployment",
  "@koi/channel-voice": "Bridge real-time voice I/O via LiveKit with STT/TTS",
  "@koi/channel-whatsapp": "Connect WhatsApp bots via Baileys Web emulation",
  "@koi/gateway": "Route messages, authenticate sessions, dispatch webhooks, and register nodes",
  "@koi/mcp-server": "Expose agent tools via Model Context Protocol",
  "@koi/mcp": "Bridge MCP tool servers and attach discovered tools as Koi components",
  "@koi/name-service": "Register and resolve agent names with TTL expiry and fuzzy suggestions",
  "@koi/webhook-delivery":
    "Deliver agent events as signed HTTP POSTs with retry and circuit breaking",
  "@koi/webhook-provider": "Expose read-only webhook health and configuration as agent tools",

  // ── IPC (orchestration) ──────────────────────────────────────────────
  "@koi/federation": "Coordinate multi-zone agents with vector clock sync and conflict resolution",
  "@koi/handoff": "Relay typed context between agents via structured handoff tools and middleware",
  "@koi/ipc-local": "Route messages between in-process agents using in-memory mailbox dispatch",
  "@koi/ipc-nexus":
    "Enable agent messaging via Nexus REST API with subscriptions and inbox listing",
  "@koi/scratchpad-local": "Store versioned files with CAS and TTL in in-memory scratchpad",
  "@koi/scratchpad-nexus":
    "Persist agent scratchpad state across zones via Nexus group-scoped storage",
  "@koi/task-spawn":
    "Inject task tool for zero-friction delegation to pre-registered subagent types",
  "@koi/workspace": "Isolate agent workspaces via pluggable backends (git worktrees, Docker, etc.)",
  "@koi/workspace-nexus": "Sync workspace metadata across devices via Nexus Raft-replicated store",

  // ── Middleware ────────────────────────────────────────────────────────
  "@koi/middleware-call-dedup":
    "Cache identical tool call results per session to avoid redundant re-execution",
  "@koi/middleware-call-limits":
    "Enforce per-session and per-tool call count limits with configurable exit behavior",
  "@koi/middleware-degenerate":
    "Select primary implementation for capabilities with multiple variants and handle failover",
  "@koi/middleware-feedback-loop":
    "Validate model and tool outputs, retry with error feedback, enforce quality gates",
  "@koi/middleware-fs-rollback":
    "Capture filesystem snapshots during tool calls and enable rollback to prior states",
  "@koi/middleware-goal":
    "Goal-directed middleware trio: anchor (todo injection), reminder (adaptive periodic), and planning (write_plan tool)",
  "@koi/middleware-guided-retry":
    "Inject constraint hints into model calls after backtrack or fork events",
  "@koi/middleware-output-verifier":
    "Run deterministic and LLM-as-judge quality checks before delivering model outputs",
  "@koi/middleware-report":
    "Generate human-readable summaries of autonomous agent run activities and outcomes",
  "@koi/middleware-sandbox":
    "Enforce timeout, output truncation, and error classification for sandboxed tools",
  "@koi/middleware-semantic-retry":
    "Analyze failure root causes and rewrite prompts with context-aware retry actions",
  "@koi/middleware-tool-audit":
    "Track per-tool usage, latency, success rates and emit lifecycle signals",
  "@koi/middleware-tool-recovery":
    "Recover structured tool calls from text patterns in model responses",
  "@koi/middleware-tool-selector":
    "Pre-filter tools before model calls using profile or selector function",
  "@koi/middleware-turn-ack":
    "Send processing and idle status signals for long-running agent turns",

  // ── MM (memory management) ──────────────────────────────────────────
  "@koi/context":
    "Hydrate agent context from multiple sources at session start and inject as system message",
  "@koi/memory-fs":
    "Store and retrieve memories using filesystem-backed categorized fact store with search",
  "@koi/middleware-ace":
    "Record trajectories and consolidate learnings into persistent playbooks per session",
  "@koi/middleware-compactor":
    "Compact old conversation history into structured summaries at configurable thresholds",
  "@koi/middleware-conversation":
    "Link stateless channel sessions by loading thread history and persisting new turns",
  "@koi/middleware-context-editing":
    "Replace old tool results with placeholders when token count exceeds threshold",
  "@koi/middleware-hot-memory":
    "Inject hot-tier memories into model calls at configurable intervals",
  "@koi/session-repair":
    "Validate and repair message history through orphan repair, dedup, and merge phases",
  "@koi/session-store": "Persist sessions durably to enable crash recovery and resume capabilities",
  "@koi/snapshot-chain-store":
    "Store snapshot chains in memory with full DAG topology and ancestor walking",
  "@koi/snapshot-store-sqlite":
    "Persist snapshot chains durably with WAL-mode storage and content-hash dedup",
  "@koi/token-estimator":
    "Estimate tokens using configurable heuristics (default: 4 chars per token)",
  "@koi/tool-squash":
    "Compress old messages with agent-provided summary and archive originals to store",
  "@koi/transcript":
    "Log messages durably as append-only JSONL or in-memory transcript for recovery",

  // ── Security ─────────────────────────────────────────────────────────
  "@koi/audit-sink-local": "Persist audit events to SQLite or NDJSON files for offline operation",
  "@koi/audit-sink-nexus":
    "Batch and forward audit entries to Nexus server via JSON-RPC with retry",
  "@koi/capability-verifier":
    "Verify HMAC and Ed25519 capability tokens, track session revocation, validate delegation chains",
  "@koi/delegation":
    "Create monotonically attenuated delegation tokens with scope checking and cascading revocation",
  "@koi/doctor": "Static security analysis of agent manifests aligned with OWASP Agentic Top 10",
  "@koi/exec-approvals":
    "Enforce progressive command allowlisting with user approval decisions across session",
  "@koi/governance-memory":
    "Evaluate Cedar-inspired constraint DAGs with adaptive thresholds and anomaly integration",
  "@koi/middleware-audit":
    "Log structured audit entries for all model/tool calls with PII redaction support",
  "@koi/middleware-delegation-escalation":
    "Escalate to humans when delegatee circuit breakers exhaust via bidirectional channel",
  "@koi/middleware-governance-backend":
    "Wrap model/tool calls with fail-closed policy evaluation gate",
  "@koi/middleware-guardrails":
    "Validate agent outputs against Zod schemas to prevent malformed responses and data leaks",
  "@koi/middleware-intent-capsule":
    "Sign and verify agent mandate (system prompt + objectives) to defend against goal hijacking",
  "@koi/middleware-pay":
    "Track token costs per call, enforce budget limits, and alert on threshold crossings",
  "@koi/middleware-permissions":
    "Check tool access via pluggable backend with human-in-the-loop approval support",
  "@koi/middleware-pii":
    "Detect and redact PII (email, SSN, card, IP, MAC, phone, URL) in agent I/O",
  "@koi/middleware-sanitize":
    "Strip injection patterns, control characters, HTML tags, and zero-width chars from content",
  "@koi/permissions-nexus":
    "Forward permission queries to Nexus ReBAC server with typed contract implementations",
  "@koi/redaction":
    "Mask secrets (API keys, credentials, tokens) in logs with 13 built-in pattern detectors",
  "@koi/scope":
    "Wrap infrastructure tokens with capability-attenuation scopes (filesystem, browser, credentials, memory)",
  "@koi/security-analyzer":
    "Classify tool call risk via pattern matching and multi-analyzer aggregation with anomaly elevation",

  // ── Virt (sandboxes) ─────────────────────────────────────────────────
  "@koi/code-executor":
    "Execute scripts via Wasm sandbox for multi-tool orchestration in a single turn",
  "@koi/sandbox": "Provide OS-level sandboxing with macOS Seatbelt and Linux bubblewrap isolation",
  "@koi/sandbox-cloud-base":
    "Share cloud sandbox utilities: bridge caching, error classification, truncation, tests",
  "@koi/sandbox-cloudflare":
    "Execute code in Cloudflare Workers with optional R2 FUSE mount support",
  "@koi/sandbox-daytona": "Execute code in Daytona cloud with native FUSE volume support",
  "@koi/sandbox-docker":
    "Execute code in Docker containers with offline support and iptables enforcement",
  "@koi/sandbox-e2b": "Execute code in E2B Firecracker microVMs for remote sandboxed execution",
  "@koi/sandbox-executor":
    "Provide subprocess and promoted (in-process) executors for sandbox verification",
  "@koi/sandbox-ipc": "Bridge OS-level sandboxing with forge verification via structured IPC",
  "@koi/sandbox-vercel":
    "Execute code in Vercel Firecracker microVMs for remote sandboxed execution",
  "@koi/sandbox-wasm": "Execute code in Wasm sandboxes with sync and async executor variants",

  // ── Forge ────────────────────────────────────────────────────────────
  "@koi/crystallize":
    "Detect repeating tool patterns and surface crystallization candidates for forging",
  "@koi/forge-demand": "Detect capability gaps and repeated failures that demand new tool creation",
  "@koi/forge-exaptation": "Monitor tool usage for purpose drift when bricks diverge from design",
  "@koi/forge-integrity":
    "Verify provenance, sign attestations, and serialize SLSA v1.0 predicates",
  "@koi/forge-optimizer":
    "Evaluate composite bricks against components and auto-deprecate underperforming ones",
  "@koi/forge-policy": "Enforce governance, track usage, detect drift, and re-verify brick changes",
  "@koi/forge-tools": "Provide primordial tools, component provider, resolver, and store utilities",
  "@koi/forge-types": "Define shared types, errors, config, and interfaces for the forge subsystem",
  "@koi/forge-verifier":
    "Verify bricks with adversarial probes, dependency audits, and test generation",

  // ── Sched ────────────────────────────────────────────────────────────
  "@koi/harness-scheduler": "Auto-resume suspended harness with poll-based scheduling and backoff",
  "@koi/long-running":
    "Manage agents over hours/days across sessions with checkpointing and context",
  "@koi/scheduler": "Schedule tasks with priority queue, cron, retry, dead-letter, and concurrency",
  "@koi/scheduler-nexus":
    "Delegate priority dispatch to Nexus while retaining local cron and retry",
  "@koi/scheduler-provider":
    "Expose scheduler as agent-facing tools scoped to individual agent identity",
  "@koi/verified-loop":
    "Shift control from LLM self-assessment to external objective verification loops",

  // ── Deploy ───────────────────────────────────────────────────────────
  "@koi/bundle":
    "Serialize and import portable agent bundles with integrity verification and deduplication",
  "@koi/deploy":
    "Generate OS-native service files and manage agent lifecycle (systemd/launchd, health checks)",
  "@koi/node":
    "Host multiplexed agents on local machines with WebSocket gateway, tool resolution, mDNS discovery",

  // ── Meta (L3) ────────────────────────────────────────────────────────
  "@koi/autonomous":
    "Compose long-running harness, scheduler, and checkpoint/inbox middleware into autonomous agents",
  "@koi/cli": "Interactive command-line interface for agent initialization and local execution",
  "@koi/context-arena":
    "Allocate token budgets across context management middleware with preset-driven profiles",
  "@koi/forge":
    "Self-extending system for agent composition, verification, integrity attestation, and policy enforcement",
  "@koi/governance":
    "Enterprise compliance stack composing 9 middleware for permissions, approvals, auditing, and guardrails",
  "@koi/rlm-stack":
    "Wire code-execution sandbox into RLM middleware for script-based input analysis",
  "@koi/sandbox-stack":
    "One-call factory for sandboxed code execution with timeout guards and pluggable backend adapters",
  "@koi/starter":
    "Auto-wire manifest-declared middleware without manual factory calls, with callback customization",

  // ── Observability ────────────────────────────────────────────────────
  "@koi/agent-discovery": "Discover external coding agents from PATH, filesystem, and MCP servers",
  "@koi/agent-monitor":
    "Detect anomalous agent behavior via adversarial middleware (excessive calls, errors)",
  "@koi/agent-procfs":
    "Expose agent runtime state via virtual filesystem mounts with TTL microcache",
  "@koi/channel-agui":
    "AG-UI SSE channel adapter — connect CopilotKit-compatible web frontends to Koi agents",
  "@koi/dashboard-api":
    "Serve REST endpoints + SSE events for agent/channel/skill dashboard metrics",
  "@koi/dashboard-types": "Define shared dashboard event discriminated unions and REST API types",
  "@koi/dashboard-ui": "Web dashboard for observing agents, channels, skills, and system metrics",
  "@koi/debug": "Attach runtime debugger with breakpoints, step/pause, and component inspection",
  "@koi/eval": "Run agent evaluation scenarios with graders, regression detection, and scoring",
  "@koi/middleware-event-trace":
    "Trace individual LLM/tool calls for fine-grained mid-turn event replay",
  "@koi/self-test":
    "Execute pre-deployment smoke tests validating manifests, middleware, and E2E flows",
  "@koi/tracing": "Emit OpenTelemetry spans for session, turn, model, and tool lifecycle events",
} as const;

/** Insert `description` immediately after `name` in raw JSON text. */
function insertDescription(jsonText: string, description: string): string {
  // Match the "name": "..." line and insert description after it
  const nameLineRe = /^(\s*"name"\s*:\s*"[^"]*")(,?\s*)$/m;
  const match = nameLineRe.exec(jsonText);
  if (!match) {
    throw new Error("Could not find 'name' field in package.json");
  }

  const nameLine = match[1] ?? "";
  const trailing = match[2] ?? "";
  const indent = nameLine.match(/^(\s*)/)?.[1] ?? "  ";

  // Ensure trailing comma after name line
  const nameWithComma = nameLine.endsWith(",") ? nameLine : `${nameLine},`;
  const descLine = `${indent}"description": ${JSON.stringify(description)}`;

  return jsonText.replace(match[0], `${nameWithComma}\n${descLine}${trailing}`);
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");

  // Collect all package.json paths
  const packageJsonPaths: string[] = [];

  // Root
  packageJsonPaths.push(`${ROOT}package.json`);

  // E2E
  packageJsonPaths.push(`${ROOT}tests/e2e/package.json`);

  // Recipes
  const recipesGlob = new Bun.Glob("recipes/*/package.json");
  for await (const path of recipesGlob.scan({ cwd: ROOT, absolute: true })) {
    packageJsonPaths.push(path);
  }

  // All workspace packages
  const pkgGlob = new Bun.Glob("packages/*/*/package.json");
  for await (const path of pkgGlob.scan({ cwd: ROOT, absolute: true })) {
    packageJsonPaths.push(path);
  }

  let updated = 0;
  let skipped = 0;
  const missing: string[] = [];
  const errors: string[] = [];

  for (const pkgPath of packageJsonPaths) {
    try {
      const text = await Bun.file(pkgPath).text();
      const parsed = JSON.parse(text) as { readonly name?: string; readonly description?: string };
      const name = parsed.name;

      if (!name) {
        errors.push(`${pkgPath}: no 'name' field`);
        continue;
      }

      const description = DESCRIPTIONS[name];
      if (!description) {
        missing.push(name);
        continue;
      }

      // Skip if already has the correct description
      if (parsed.description === description) {
        skipped++;
        continue;
      }

      // Remove existing description via JSON-aware rewrite to avoid regex edge cases
      let cleanText = text;
      if (parsed.description !== undefined) {
        // Match description field with any JSON string value (handles escaped quotes)
        const descRe = /^\s*"description"\s*:\s*"(?:[^"\\]|\\.)*",?\s*\n/m;
        const removed = cleanText.replace(descRe, "");
        if (removed.length === cleanText.length) {
          errors.push(`${pkgPath}: could not remove existing description — manual fix required`);
          continue;
        }
        cleanText = removed;
      }

      const newText = insertDescription(cleanText, description);

      if (dryRun) {
        console.log(`[dry-run] ${name}: ${description}`);
      } else {
        await Bun.write(pkgPath, newText);
      }
      updated++;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${pkgPath}: ${msg}`);
    }
  }

  console.log(`\n${dryRun ? "[DRY RUN] " : ""}Results:`);
  console.log(`  Updated: ${updated}`);
  console.log(`  Skipped (already correct): ${skipped}`);

  if (missing.length > 0) {
    console.log(`\n  Missing from lookup table (${missing.length}):`);
    for (const name of missing) {
      console.log(`    - ${name}`);
    }
  }

  if (errors.length > 0) {
    console.log(`\n  Errors (${errors.length}):`);
    for (const err of errors) {
      console.log(`    - ${err}`);
    }
    process.exit(1);
  }

  if (missing.length > 0) {
    process.exit(1);
  }

  console.log("\nDone.");
}

await main();
