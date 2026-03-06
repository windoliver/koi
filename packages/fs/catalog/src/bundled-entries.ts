/**
 * Curated bundled L2 package metadata.
 *
 * Static catalog entries for all agent-discoverable packages in the monorepo.
 * These entries enable agents to discover and attach bundled capabilities
 * without scanning the filesystem or requiring external registries.
 *
 * Packages NOT included here are L0/L0u/L1 infrastructure (core, engine,
 * errors, hash, manifest, etc.) or internal-only implementation details
 * (registries, stores, dashboard, deploy tooling).
 */

import type { CatalogEntry } from "@koi/core";

// ---------------------------------------------------------------------------
// Middleware (24 packages)
// ---------------------------------------------------------------------------

const MIDDLEWARE_ENTRIES: readonly CatalogEntry[] = [
  {
    name: "bundled:@koi/middleware-ace",
    kind: "middleware",
    source: "bundled",
    description: "Autonomous code execution middleware with safety controls",
    tags: ["middleware", "code-execution", "autonomy"],
  },
  {
    name: "bundled:@koi/middleware-audit",
    kind: "middleware",
    source: "bundled",
    description: "Structured audit logging for all model and tool calls",
    tags: ["middleware", "audit", "logging", "compliance"],
  },
  {
    name: "bundled:@koi/middleware-call-limits",
    kind: "middleware",
    source: "bundled",
    description: "Configurable limits on model and tool call frequency",
    tags: ["middleware", "limits", "rate-limiting", "safety"],
  },
  {
    name: "bundled:@koi/middleware-compactor",
    kind: "middleware",
    source: "bundled",
    description: "Context window compaction to stay within token limits",
    tags: ["middleware", "compaction", "context", "tokens"],
  },
  {
    name: "bundled:@koi/middleware-context-editing",
    kind: "middleware",
    source: "bundled",
    description: "Dynamic context editing and message rewriting",
    tags: ["middleware", "context", "editing", "messages"],
  },
  {
    name: "bundled:@koi/middleware-event-trace",
    kind: "middleware",
    source: "bundled",
    description: "Turn-level event tracing for debugging and observability",
    tags: ["middleware", "tracing", "observability", "debugging"],
  },
  {
    name: "bundled:@koi/middleware-feedback-loop",
    kind: "middleware",
    source: "bundled",
    description: "Automated test-fix feedback loop for iterative code repair",
    tags: ["middleware", "feedback", "testing", "automation"],
  },
  {
    name: "bundled:@koi/middleware-fs-rollback",
    kind: "middleware",
    source: "bundled",
    description: "Filesystem change tracking and rollback on tool failure",
    tags: ["middleware", "filesystem", "rollback", "safety"],
  },
  {
    name: "bundled:@koi/middleware-goal",
    kind: "middleware",
    source: "bundled",
    description: "Goal-directed middleware trio: anchor, reminder, and planning",
    tags: ["middleware", "goal", "focus", "steering", "planning"],
  },
  {
    name: "bundled:@koi/middleware-governance-backend",
    kind: "middleware",
    source: "bundled",
    description: "Policy enforcement backend for governance rules and constraints",
    tags: ["middleware", "governance", "policy", "compliance"],
  },
  {
    name: "bundled:@koi/middleware-guardrails",
    kind: "middleware",
    source: "bundled",
    description: "Safety guardrails for content filtering and output validation",
    tags: ["middleware", "guardrails", "safety", "content-filtering"],
  },
  {
    name: "bundled:@koi/middleware-guided-retry",
    kind: "middleware",
    source: "bundled",
    description: "Configurable retry middleware with exponential backoff",
    tags: ["middleware", "retry", "backoff", "resilience"],
  },
  {
    name: "bundled:@koi/middleware-integration",
    kind: "middleware",
    source: "bundled",
    description: "Integration middleware for connecting external services",
    tags: ["middleware", "integration", "services"],
  },
  {
    name: "bundled:@koi/middleware-output-verifier",
    kind: "middleware",
    source: "bundled",
    description: "Output verification and validation against expected formats",
    tags: ["middleware", "verification", "validation", "output"],
  },
  {
    name: "bundled:@koi/middleware-pay",
    kind: "middleware",
    source: "bundled",
    description: "Usage-based billing and cost tracking middleware",
    tags: ["middleware", "billing", "cost", "metering"],
  },
  {
    name: "bundled:@koi/middleware-permissions",
    kind: "middleware",
    source: "bundled",
    description: "Tool-level permission enforcement middleware",
    tags: ["middleware", "permissions", "security", "access-control"],
  },
  {
    name: "bundled:@koi/middleware-pii",
    kind: "middleware",
    source: "bundled",
    description: "PII detection and redaction in model inputs and outputs",
    tags: ["middleware", "pii", "redaction", "privacy"],
  },
  // @koi/middleware-planning merged into @koi/middleware-goal
  {
    name: "bundled:@koi/middleware-report",
    kind: "middleware",
    source: "bundled",
    description: "Report generation middleware for structured output summaries",
    tags: ["middleware", "report", "summary", "output"],
  },
  {
    name: "bundled:@koi/middleware-sandbox",
    kind: "middleware",
    source: "bundled",
    description: "Sandbox enforcement middleware for code execution isolation",
    tags: ["middleware", "sandbox", "isolation", "security"],
  },
  {
    name: "bundled:@koi/middleware-sanitize",
    kind: "middleware",
    source: "bundled",
    description: "Input sanitization middleware to prevent injection attacks",
    tags: ["middleware", "sanitize", "security", "injection"],
  },
  {
    name: "bundled:@koi/middleware-semantic-retry",
    kind: "middleware",
    source: "bundled",
    description: "LLM-guided semantic retry with error analysis and correction",
    tags: ["middleware", "retry", "error-handling", "resilience"],
  },
  {
    name: "bundled:@koi/middleware-soul",
    kind: "middleware",
    source: "bundled",
    description: "Personality and behavioral traits middleware for agent identity",
    tags: ["middleware", "personality", "soul", "identity"],
  },
  {
    name: "bundled:@koi/middleware-tool-selector",
    kind: "middleware",
    source: "bundled",
    description: "Intelligent tool selection and recommendation middleware",
    tags: ["middleware", "tool-selection", "routing", "optimization"],
  },
  {
    name: "bundled:@koi/middleware-turn-ack",
    kind: "middleware",
    source: "bundled",
    description: "Turn acknowledgement with timeout and progress tracking",
    tags: ["middleware", "turn", "acknowledgement", "progress"],
  },
] as const satisfies readonly CatalogEntry[];

// ---------------------------------------------------------------------------
// Channels (6 packages)
// ---------------------------------------------------------------------------

const CHANNEL_ENTRIES: readonly CatalogEntry[] = [
  {
    name: "bundled:@koi/channel-canvas-fallback",
    kind: "channel",
    source: "bundled",
    description: "Canvas rendering fallback channel for visual output",
    tags: ["channel", "canvas", "visual", "fallback"],
  },
  {
    name: "bundled:@koi/channel-chat-sdk",
    kind: "channel",
    source: "bundled",
    description: "Chat SDK integration channel for embedding agents in apps",
    tags: ["channel", "chat", "sdk", "embedding"],
  },
  {
    name: "bundled:@koi/channel-cli",
    kind: "channel",
    source: "bundled",
    description: "Terminal-based CLI channel with rich formatting",
    tags: ["channel", "cli", "terminal"],
  },
  {
    name: "bundled:@koi/channel-discord",
    kind: "channel",
    source: "bundled",
    description: "Discord bot channel for agent interaction via Discord",
    tags: ["channel", "discord", "bot", "chat"],
  },
  {
    name: "bundled:@koi/channel-telegram",
    kind: "channel",
    source: "bundled",
    description: "Telegram bot channel for agent interaction via Telegram",
    tags: ["channel", "telegram", "bot", "chat"],
  },
  {
    name: "bundled:@koi/channel-voice",
    kind: "channel",
    source: "bundled",
    description: "Voice channel for speech-to-text and text-to-speech interaction",
    tags: ["channel", "voice", "speech", "audio"],
  },
] as const satisfies readonly CatalogEntry[];

// ---------------------------------------------------------------------------
// Engine adapters (4 packages)
// ---------------------------------------------------------------------------

const ENGINE_ENTRIES: readonly CatalogEntry[] = [
  {
    name: "bundled:@koi/engine-claude",
    kind: "tool",
    source: "bundled",
    description: "Claude (Anthropic) engine adapter for model interaction",
    tags: ["engine", "claude", "anthropic", "llm"],
  },
  {
    name: "bundled:@koi/engine-external",
    kind: "tool",
    source: "bundled",
    description: "External model engine adapter for third-party LLM providers",
    tags: ["engine", "external", "llm", "provider"],
  },
  {
    name: "bundled:@koi/engine-loop",
    kind: "tool",
    source: "bundled",
    description: "Loop-based engine for deterministic multi-step agent execution",
    tags: ["engine", "loop", "deterministic", "execution"],
  },
  {
    name: "bundled:@koi/engine-pi",
    kind: "tool",
    source: "bundled",
    description: "Pi model engine adapter for Inflection AI interaction",
    tags: ["engine", "pi", "inflection", "llm"],
  },
] as const satisfies readonly CatalogEntry[];

// ---------------------------------------------------------------------------
// Sandbox providers (10 packages)
// ---------------------------------------------------------------------------

const SANDBOX_ENTRIES: readonly CatalogEntry[] = [
  {
    name: "bundled:@koi/sandbox",
    kind: "tool",
    source: "bundled",
    description: "Code execution sandbox with configurable isolation profiles",
    tags: ["sandbox", "execution", "isolation", "security"],
  },
  {
    name: "bundled:@koi/sandbox-cloud-base",
    kind: "tool",
    source: "bundled",
    description: "Base cloud sandbox abstraction for remote execution providers",
    tags: ["sandbox", "cloud", "remote", "base"],
  },
  {
    name: "bundled:@koi/sandbox-cloudflare",
    kind: "tool",
    source: "bundled",
    description: "Cloudflare Workers sandbox for edge-based code execution",
    tags: ["sandbox", "cloudflare", "workers", "edge"],
  },
  {
    name: "bundled:@koi/sandbox-daytona",
    kind: "tool",
    source: "bundled",
    description: "Daytona sandbox for cloud development environment execution",
    tags: ["sandbox", "daytona", "cloud", "dev-environment"],
  },
  {
    name: "bundled:@koi/sandbox-docker",
    kind: "tool",
    source: "bundled",
    description: "Docker container sandbox for isolated code execution",
    tags: ["sandbox", "docker", "container", "isolation"],
  },
  {
    name: "bundled:@koi/sandbox-e2b",
    kind: "tool",
    source: "bundled",
    description: "E2B sandbox for secure AI-generated code execution",
    tags: ["sandbox", "e2b", "secure", "ai-execution"],
  },
  {
    name: "bundled:@koi/sandbox-executor",
    kind: "tool",
    source: "bundled",
    description: "Base sandbox executor with command and script execution",
    tags: ["sandbox", "executor", "base", "execution"],
  },
  {
    name: "bundled:@koi/sandbox-ipc",
    kind: "tool",
    source: "bundled",
    description: "IPC-based sandbox using inter-process communication isolation",
    tags: ["sandbox", "ipc", "process", "isolation"],
  },
  {
    name: "bundled:@koi/sandbox-vercel",
    kind: "tool",
    source: "bundled",
    description: "Vercel sandbox for serverless function execution",
    tags: ["sandbox", "vercel", "serverless", "execution"],
  },
  {
    name: "bundled:@koi/sandbox-wasm",
    kind: "tool",
    source: "bundled",
    description: "WebAssembly sandbox for lightweight in-process isolation",
    tags: ["sandbox", "wasm", "webassembly", "lightweight"],
  },
] as const satisfies readonly CatalogEntry[];

// ---------------------------------------------------------------------------
// Tools (3 packages)
// ---------------------------------------------------------------------------

const TOOL_ENTRIES: readonly CatalogEntry[] = [
  {
    name: "bundled:@koi/tool-browser",
    kind: "tool",
    source: "bundled",
    description: "Browser automation tool for web scraping and interaction",
    tags: ["tool", "browser", "automation", "web"],
  },
  {
    name: "bundled:@koi/tools-github",
    kind: "tool",
    source: "bundled",
    description: "GitHub API tools for repository, issue, and PR management",
    tags: ["tool", "github", "api", "repository"],
  },
  {
    name: "bundled:@koi/tools-web",
    kind: "tool",
    source: "bundled",
    description: "Web scraping and content extraction tools",
    tags: ["tool", "web", "scraping", "content"],
  },
] as const satisfies readonly CatalogEntry[];

// ---------------------------------------------------------------------------
// Agent infrastructure (agent-facing capabilities)
// ---------------------------------------------------------------------------

const INFRASTRUCTURE_ENTRIES: readonly CatalogEntry[] = [
  {
    name: "bundled:@koi/context",
    kind: "tool",
    source: "bundled",
    description: "Context window management and compaction",
    tags: ["context", "compaction", "token-management"],
  },
  {
    name: "bundled:@koi/delegation",
    kind: "tool",
    source: "bundled",
    description: "Inter-agent delegation with capability-based authorization",
    tags: ["delegation", "multi-agent", "authorization"],
  },
  {
    name: "bundled:@koi/eval",
    kind: "tool",
    source: "bundled",
    description: "Evaluation framework for testing agent capabilities",
    tags: ["eval", "testing", "benchmarks", "quality"],
  },
  {
    name: "bundled:@koi/forge",
    kind: "tool",
    source: "bundled",
    description: "Self-extension system — forge tools, skills, agents, and middleware at runtime",
    tags: ["forge", "self-extension", "code-generation", "runtime"],
  },
  {
    name: "bundled:@koi/gateway",
    kind: "tool",
    source: "bundled",
    description: "Agent gateway for external API exposure and routing",
    tags: ["gateway", "api", "routing", "external"],
  },
  {
    name: "bundled:@koi/governance",
    kind: "tool",
    source: "bundled",
    description: "Governance policy engine for agent behavior constraints",
    tags: ["governance", "policy", "compliance", "constraints"],
  },
  {
    name: "bundled:@koi/handoff",
    kind: "tool",
    source: "bundled",
    description: "Agent handoff for transferring conversations between agents",
    tags: ["handoff", "transfer", "multi-agent", "conversation"],
  },
  {
    name: "bundled:@koi/identity",
    kind: "tool",
    source: "bundled",
    description: "Identity management for agent authentication and authorization",
    tags: ["identity", "auth", "authentication", "authorization"],
  },
  {
    name: "bundled:@koi/long-running",
    kind: "tool",
    source: "bundled",
    description: "Long-running task support with progress tracking and resumption",
    tags: ["long-running", "tasks", "progress", "resumption"],
  },
  {
    name: "bundled:@koi/lsp",
    kind: "tool",
    source: "bundled",
    description: "Language Server Protocol integration for code intelligence",
    tags: ["lsp", "language-server", "code-intelligence", "ide"],
  },
  {
    name: "bundled:@koi/mcp",
    kind: "tool",
    source: "bundled",
    description: "Model Context Protocol bridge — connect external MCP tool servers",
    tags: ["mcp", "tools", "integration", "protocol"],
  },
  {
    name: "bundled:@koi/model-router",
    kind: "tool",
    source: "bundled",
    description: "Intelligent model routing across multiple providers",
    tags: ["model", "routing", "multi-provider", "optimization"],
  },
  {
    name: "bundled:@koi/orchestrator",
    kind: "tool",
    source: "bundled",
    description: "Agent orchestration for coordinating multi-agent workflows",
    tags: ["orchestrator", "multi-agent", "workflow", "coordination"],
  },
  {
    name: "bundled:@koi/parallel-minions",
    kind: "tool",
    source: "bundled",
    description: "Parallel task execution with fan-out and fan-in patterns",
    tags: ["parallel", "fan-out", "concurrency", "task-execution"],
  },
  {
    name: "bundled:@koi/redaction",
    kind: "tool",
    source: "bundled",
    description: "Data redaction utilities for sensitive information removal",
    tags: ["redaction", "privacy", "sensitive-data", "security"],
  },
  {
    name: "bundled:@koi/scheduler",
    kind: "tool",
    source: "bundled",
    description: "Cron-based task scheduling with persistent store",
    tags: ["scheduler", "cron", "tasks", "automation"],
  },
  {
    name: "bundled:@koi/scope",
    kind: "tool",
    source: "bundled",
    description: "Scope management for permission boundaries and access control",
    tags: ["scope", "permissions", "boundaries", "access-control"],
  },
  {
    name: "bundled:@koi/search",
    kind: "tool",
    source: "bundled",
    description: "Web search abstraction with pluggable backends",
    tags: ["search", "web", "information-retrieval"],
  },
  {
    name: "bundled:@koi/search-brave",
    kind: "tool",
    source: "bundled",
    description: "Brave Search backend for web search queries",
    tags: ["search", "brave", "web", "backend"],
  },
  {
    name: "bundled:@koi/task-spawn",
    kind: "tool",
    source: "bundled",
    description: "Task spawning for creating child agent tasks",
    tags: ["task", "spawn", "child-agent", "delegation"],
  },
  {
    name: "bundled:@koi/tracing",
    kind: "tool",
    source: "bundled",
    description: "Distributed tracing for agent execution observability",
    tags: ["tracing", "observability", "distributed", "debugging"],
  },
] as const satisfies readonly CatalogEntry[];

// ---------------------------------------------------------------------------
// Combined export
// ---------------------------------------------------------------------------

export const BUNDLED_ENTRIES: readonly CatalogEntry[] = [
  ...MIDDLEWARE_ENTRIES,
  ...CHANNEL_ENTRIES,
  ...ENGINE_ENTRIES,
  ...SANDBOX_ENTRIES,
  ...TOOL_ENTRIES,
  ...INFRASTRUCTURE_ENTRIES,
] as const satisfies readonly CatalogEntry[];
