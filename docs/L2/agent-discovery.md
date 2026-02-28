# @koi/agent-discovery — Runtime Discovery of External Coding Agents

Discovers external coding agents (Claude Code, Aider, Codex, Gemini CLI, etc.) available on the host machine and exposes them as a Koi tool + ECS component. One factory call (`createDiscoveryProvider()`) wires up PATH scanning, filesystem registry, and MCP server introspection — any engine adapter discovers the `discover_agents` tool automatically.

---

## Why It Exists

Koi agents are self-contained by default — they know about their own tools but have zero awareness of other agents on the machine. For an agent to delegate, collaborate, or reason about specialization, it needs to know **what else is available**.

`@koi/agent-discovery` solves this by scanning 3 sources at runtime and exposing results as both a callable tool (for LLM-driven discovery) and an ECS singleton (for programmatic access).

```
 BEFORE                              AFTER
 ══════                              ═════

 Koi Agent                           Koi Agent
 ┌──────────────┐                    ┌──────────────┐
 │ knows own    │                    │ knows own    │
 │ tools only   │                    │ tools        │
 │              │                    │              │
 │ no awareness │                    │ + discovers: │
 │ of other     │                    │   claude-code│
 │ agents       │                    │   aider      │
 └──────────────┘                    │   codex      │
                                     │   mcp-*      │
                                     │   custom-*   │
                                     └──────┬───────┘
                                            │
                                            ▼
                                     can reason about
                                     delegation and
                                     specialization
```

---

## What This Enables

### Agent-Driven Discovery

```
┌─────────────────────────────────────────────────────────────────┐
│                       KOI RUNTIME (L1)                          │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │              YOUR KOI AGENT                                │ │
│  │                                                            │ │
│  │  User: "Find agents that can help review code"             │ │
│  │                                                            │ │
│  │  LLM: "I'll use discover_agents"                           │ │
│  │        │                                                   │ │
│  │        ▼                                                   │ │
│  │  ┌──────────────────────────┐                              │ │
│  │  │  discover_agents         │ ◄── tool call                │ │
│  │  │  { capability:           │                              │ │
│  │  │    "code-review" }       │                              │ │
│  │  └────────────┬─────────────┘                              │ │
│  └───────────────│────────────────────────────────────────────┘ │
│                  │                                               │
│     ┌────────────▼──────────────┐                               │
│     │   MIDDLEWARE CHAIN        │                               │
│     │   wrapToolCall fires      │ ◄── audit, permissions,      │
│     │   for every observer      │     logging all see it       │
│     └────────────┬──────────────┘                               │
│                  │                                               │
│     ┌────────────▼──────────────┐                               │
│     │  DISCOVERY PROVIDER       │                               │
│     │                           │                               │
│     │  Scans 3 sources:         │                               │
│     └──┬──────┬──────┬──────────┘                               │
│        │      │      │                                           │
│        ▼      ▼      ▼                                           │
│   ┌────────┐ ┌──────────┐ ┌────────────┐                       │
│   │  PATH  │ │FILESYSTEM│ │MCP SERVERS │                       │
│   │Scanner │ │ Scanner  │ │ Scanner    │                       │
│   │        │ │          │ │            │                       │
│   │which() │ │~/.koi/   │ │query MCP   │                       │
│   │checks  │ │agents/   │ │for tools   │                       │
│   └───┬────┘ └────┬─────┘ └─────┬──────┘                       │
│       ▼           ▼             ▼                                │
│  claude-code  custom-agent  mcp-server-x                        │
│  aider        ...           ...                                  │
│  codex                                                           │
│  gemini-cli                                                      │
└─────────────────────────────────────────────────────────────────┘

                        │
                        ▼  tool response

  { agents: [
      { name: "claude-code",  transport: "cli",
        capabilities: ["code-generation", "code-review"],
        healthy: true },
      { name: "aider",        transport: "cli",
        capabilities: ["code-generation", "code-review"],
        healthy: true },
      { name: "mcp-server-x", transport: "mcp",
        capabilities: ["code-review"],
        healthy: true }
    ],
    count: 3
  }

                        │
                        ▼  LLM incorporates results

  "I found 3 agents. Claude Code and MCP Server X
   both support code-review. Want me to delegate?"
```

### Future: Self-Extending Agent Mesh

```
┌──────────┐    discover    ┌──────────┐    discover    ┌──────────┐
│ Koi      │ ◄────────────► │ Claude   │ ◄────────────► │ Aider    │
│ Agent A  │                │ Code     │                │          │
│ (planner)│                │ (coder)  │                │ (coder)  │
└────┬─────┘                └──────────┘                └──────────┘
     │
     │  "I need code review — who's available?"
     │
     ▼
discover_agents({ capability: "code-review" })
     │
     ▼
delegates task ──► best available agent
```

---

## Architecture

### Layer Position

```
L0  @koi/core ──────────────────────────────────────────┐
    ExternalAgentDescriptor, ExternalAgentSource,         │
    ExternalAgentTransport, ComponentProvider,             │
    Tool, ToolDescriptor, toolToken, EXTERNAL_AGENTS      │
                                                          │
                                                          ▼
L2  @koi/agent-discovery ◄──────────────────────────────┘
    imports from L0 only (runtime)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external npm dependencies
    ✓ All interface properties readonly
    ✓ Tool execute returns structured objects (never throws)
    ✓ Engine adapter agnostic (works with Pi, Loop, LangGraph)
```

### Internal Module Map

```
index.ts                   ← public re-exports
│
├── component-provider.ts  ← createDiscoveryProvider() — ComponentProvider factory
│                             wires sources → discovery → tool → ECS attach
│
├── discover-agents-tool.ts ← createDiscoverAgentsTool() — Tool factory
│                              inputSchema with capability/transport/source filters
│
├── discovery.ts           ← createDiscovery() — core aggregation engine
│                             cache + dedup + filter + partial failure handling
│
├── constants.ts           ← KNOWN_CLI_AGENTS, DEFAULT_CACHE_TTL_MS,
│                             SOURCE_PRIORITY, DEFAULT_HEALTH_TIMEOUT_MS
│
├── health.ts              ← checkAgentHealth() — CLI: --version, MCP/A2A: unknown
│
├── types.ts               ← DiscoverySource, SystemCalls, KnownCliAgent,
│                             McpAgentSource, DiscoveryFilter, DiscoveryProviderConfig
│
└── sources/
    ├── path-scanner.ts    ← createPathSource() — scans PATH for known binaries
    ├── filesystem-scanner.ts ← createFilesystemSource() — reads JSON registry dir
    └── mcp-scanner.ts     ← createMcpSource() — introspects MCP server tools
```

### Data Flow

```
createDiscoveryProvider(config?)
│
├── createPathSource()        ─── which("claude"), which("aider"), ...
├── createFilesystemSource()  ─── readdir("~/.koi/agents/*.json")
├── createMcpSource()         ─── manager.listTools() per MCP server
│
└── createDiscovery(sources, cacheTtlMs)
    │
    ├── discover() called
    │   ├── Promise.allSettled(sources.map(s => s.discover()))
    │   ├── partial success: failed sources → empty, working → results
    │   ├── deduplicateByName() — priority: MCP(0) > filesystem(1) > PATH(2)
    │   ├── cache result (TTL-gated)
    │   └── apply filters (capability, transport, source)
    │
    └── attach(agent) → Map<SubsystemToken, Component>
        ├── toolToken("discover_agents") → Tool { descriptor, execute }
        └── EXTERNAL_AGENTS             → readonly ExternalAgentDescriptor[]
```

---

## 3 Discovery Sources

### Source Table

```
╔═══════════╦═══════════════════════════════╦══════════╦════════════════════════════════╗
║ Source    ║ What it scans                  ║ Priority ║ Use case                       ║
╠═══════════╬═══════════════════════════════╬══════════╬════════════════════════════════╣
║ PATH     ║ System PATH for known binaries ║ 2 (low)  ║ Auto-detect installed agents   ║
║ Filesystem║ JSON files in a registry dir  ║ 1 (mid)  ║ User-registered custom agents  ║
║ MCP      ║ MCP servers for agent-like     ║ 0 (high) ║ Discover MCP-connected agents  ║
║          ║ tools (keyword heuristic)      ║          ║                                ║
╚═══════════╩═══════════════════════════════╩══════════╩════════════════════════════════╝
```

### PATH Scanner

Scans for 5 well-known CLI agents out of the box:

| Agent | Binary | Capabilities |
|-------|--------|-------------|
| Claude Code | `claude` | code-generation, code-review, debugging, refactoring |
| OpenAI Codex CLI | `codex` | code-generation, debugging |
| Aider | `aider` | code-generation, code-review, refactoring |
| OpenCode | `opencode` | code-generation, debugging |
| Gemini CLI | `gemini` | code-generation, code-review |

Uses `Bun.which()` for binary resolution. If found, the agent is reported as `healthy: true`. Custom agents can be added via `knownAgents` config.

### Filesystem Scanner

Reads `*.json` files from a registry directory (e.g., `~/.koi/agents/`). Each file must contain:

```json
{
  "name": "my-custom-agent",
  "transport": "cli",
  "capabilities": ["code-generation"],
  "command": "/usr/local/bin/my-agent",
  "displayName": "My Custom Agent"
}
```

- Missing directory → empty array (not an error)
- Invalid JSON → skipped (reported via `onSkip` callback)
- Path traversal attempts → blocked

### MCP Scanner

Queries MCP server managers for tools with agent-like names/descriptions. Keywords: `agent`, `assistant`, `code`, `chat`, `generate`, `review`.

Each qualifying MCP server becomes one `ExternalAgentDescriptor` with `transport: "mcp"`.

---

## Deduplication

When the same agent appears in multiple sources, priority determines which descriptor wins:

```
MCP (0) > filesystem (1) > PATH (2)
          lower number = higher priority

Example:
  PATH discovers:     { name: "shared-agent", transport: "cli", source: "path" }
  MCP discovers:      { name: "shared-agent", transport: "mcp", source: "mcp" }

  Result: MCP wins → { name: "shared-agent", transport: "mcp", source: "mcp" }
```

---

## Tool: `discover_agents`

### Descriptor

```
Name:        discover_agents
Description: Discover external coding agents available on the host machine
Trust Tier:  verified

Input Schema:
  ├── capability?  string   Filter by capability (e.g., "code-review")
  ├── transport?   string   Filter by transport: "cli" | "mcp" | "a2a"
  └── source?      string   Filter by source: "path" | "mcp" | "filesystem"

Output:
  { agents: ExternalAgentDescriptor[], count: number }
```

### ExternalAgentDescriptor Shape

```typescript
{
  name: string;                          // unique identifier
  displayName?: string;                  // human-readable name
  transport: "cli" | "mcp" | "a2a";     // communication protocol
  command?: string;                      // CLI binary name (for cli transport)
  capabilities: readonly string[];       // what it can do
  healthy?: boolean;                     // health check result
  source: "path" | "mcp" | "filesystem";// how it was discovered
  metadata?: Record<string, unknown>;    // source-specific metadata
}
```

---

## Caching

Discovery results are cached with a configurable TTL (default: 60 seconds). Key properties:

- **TTL-gated**: results are re-fetched when the cache expires
- **Inflight dedup**: concurrent `discover()` calls share a single in-flight fetch
- **Manual invalidation**: `discovery.invalidate()` clears the cache immediately

---

## API

### `createDiscoveryProvider(config?)`

The primary entry point. Creates a `ComponentProvider` that attaches the `discover_agents` tool and `EXTERNAL_AGENTS` singleton to any agent.

```typescript
import { createDiscoveryProvider } from "@koi/agent-discovery";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";

const runtime = await createKoi({
  manifest: { name: "my-agent", version: "1.0.0", model: { name: "claude-haiku-4-5" } },
  adapter: createPiAdapter({
    model: "anthropic:claude-haiku-4-5-20251001",
    getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
  }),
  providers: [createDiscoveryProvider()],
});

// Tool is now available to the LLM
runtime.agent.has(toolToken("discover_agents")); // true

// Programmatic access to discovered agents
const agents = runtime.agent.component(EXTERNAL_AGENTS);
// → readonly ExternalAgentDescriptor[]
```

### `DiscoveryProviderConfig`

```typescript
interface DiscoveryProviderConfig {
  readonly knownAgents?: readonly KnownCliAgent[];    // override KNOWN_CLI_AGENTS
  readonly systemCalls?: SystemCalls;                  // inject I/O for testing
  readonly registryDir?: string;                       // e.g., "~/.koi/agents"
  readonly mcpSources?: readonly McpAgentSource[];     // MCP server managers
  readonly cacheTtlMs?: number;                        // default: 60_000
  readonly healthTimeoutMs?: number;                   // default: 5_000
}
```

### `createDiscovery(sources, cacheTtlMs)`

Lower-level factory for custom source compositions:

```typescript
import { createDiscovery, createPathSource, createMcpSource } from "@koi/agent-discovery";

const discovery = createDiscovery(
  [createPathSource(), createMcpSource(myMcpManagers)],
  30_000, // 30s cache TTL
);

const agents = await discovery.discover({ filter: { transport: "cli" } });
discovery.invalidate(); // force re-scan on next call
```

### `createDiscoverAgentsTool(discovery)`

Creates a standalone `Tool` from a `DiscoveryHandle`:

```typescript
import { createDiscovery, createDiscoverAgentsTool } from "@koi/agent-discovery";

const discovery = createDiscovery([createPathSource()], 60_000);
const tool = createDiscoverAgentsTool(discovery);

const result = await tool.execute({ transport: "cli" });
// → { agents: [...], count: N }
```

### `createPathSource(config?)`

```typescript
const source = createPathSource({
  knownAgents: [...KNOWN_CLI_AGENTS, myCustomAgent],
  systemCalls: mockSystemCalls, // for testing
});
```

### `createFilesystemSource(registryDir)`

```typescript
const source = createFilesystemSource("~/.koi/agents");
// or with callbacks:
const source = createFilesystemSource({
  registryDir: "~/.koi/agents",
  onSkip: (filepath, reason) => console.warn(`Skipped ${filepath}: ${reason}`),
});
```

### `createMcpSource(managers)`

```typescript
const source = createMcpSource([
  {
    name: "my-mcp-server",
    listTools: async () => ({
      ok: true,
      value: [{ name: "code_assistant", description: "AI coding assistant" }],
    }),
  },
]);
```

### `checkAgentHealth(agent, systemCalls, timeoutMs?)`

```typescript
import { checkAgentHealth } from "@koi/agent-discovery";

const result = await checkAgentHealth(agent, systemCalls);
// → { status: "healthy" | "unhealthy" | "unknown", latencyMs: number, message?: string }
```

---

## Usage

### With createKoi + createPiAdapter (Full Tool Calling)

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createDiscoveryProvider } from "@koi/agent-discovery";

const runtime = await createKoi({
  manifest: { name: "discoverer", version: "1.0.0", model: { name: "claude-haiku-4-5" } },
  adapter: createPiAdapter({
    model: "anthropic:claude-haiku-4-5-20251001",
    systemPrompt: "Use discover_agents when asked about available agents.",
    getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
  }),
  providers: [createDiscoveryProvider()],
});

for await (const event of runtime.run({
  kind: "text",
  text: "What coding agents are available on this machine?",
})) {
  if (event.kind === "text_delta") process.stdout.write(event.delta);
  if (event.kind === "tool_call_start") console.log(`\n[tool] ${event.toolName}`);
}

await runtime.dispose();
```

### With Middleware (Observing Tool Calls)

```typescript
const observer: KoiMiddleware = {
  name: "discovery-logger",
  describeCapabilities: () => undefined,
  wrapToolCall: async (_ctx, request, next) => {
    if (request.toolId === "discover_agents") {
      console.log("[discovery] args:", request.input);
    }
    const response = await next(request);
    if (request.toolId === "discover_agents") {
      console.log("[discovery] result:", response.output);
    }
    return response;
  },
};

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [observer],
  providers: [createDiscoveryProvider()],
});
```

### With Custom Sources

```typescript
const provider = createDiscoveryProvider({
  registryDir: "/etc/koi/agents",
  mcpSources: [myMcpManager],
  cacheTtlMs: 120_000,
  knownAgents: [
    ...KNOWN_CLI_AGENTS,
    {
      name: "my-internal-tool",
      displayName: "Internal Code Bot",
      binaries: ["codebot"],
      capabilities: ["code-generation", "testing"],
      versionFlag: "--version",
      transport: "cli",
    },
  ],
});
```

### Programmatic Access (No LLM)

```typescript
import { EXTERNAL_AGENTS } from "@koi/core";

const runtime = await createKoi({
  manifest,
  adapter,
  providers: [createDiscoveryProvider()],
});

// Direct access to discovered agents via ECS
const agents = runtime.agent.component(EXTERNAL_AGENTS);
for (const agent of agents ?? []) {
  console.log(`${agent.name} (${agent.transport}): ${agent.capabilities.join(", ")}`);
}
```

---

## Testing

### Test Structure

```
packages/agent-discovery/src/
  component-provider.test.ts      Provider attach, ECS tokens, config
  discover-agents-tool.test.ts    Tool descriptor, filtering, edge cases
  discovery.test.ts               Cache, dedup, partial failure, invalidation
  health.test.ts                  CLI health check, non-CLI passthrough
  sources/
    path-scanner.test.ts          PATH scanning with mock SystemCalls
    filesystem-scanner.test.ts    JSON parsing, validation, path traversal
    mcp-scanner.test.ts           MCP introspection, keyword heuristics
  __tests__/
    integration.test.ts           Full pipeline: 3 sources → dedup → filter → tool
    e2e-full-stack.test.ts        Real Anthropic API through full L1 runtime
```

### Test Tiers

```
Tier 1: Unit tests (always run in CI)
═══════════════════════════════════════
  64 tests across 8 files
  ● Per-module: happy path + error paths + edge cases
  ● Mock SystemCalls for PATH scanner
  ● Mock MCP managers for MCP scanner
  ● Temp directories for filesystem scanner

Tier 2: Integration tests (always run in CI)
════════════════════════════════════════════
  8 tests in __tests__/integration.test.ts
  ● Full pipeline: 3 sources → dedup → filter → tool response
  ● Partial failure: 1 source fails, 2 succeed
  ● ComponentProvider: ECS attachment verification
  ● MCP source integration with mock managers

Tier 3: E2E with real LLM (opt-in, needs ANTHROPIC_API_KEY)
═══════════════════════════════════════════════════════════
  11 tests in __tests__/e2e-full-stack.test.ts

  Pi adapter path (4 tests):
    ● LLM calls discover_agents through full L1 runtime
    ● Middleware wrapToolCall observes the call
    ● Tool returns structured { agents, count } descriptors
    ● LLM passes filter arguments (transport: "cli")

  Loop adapter path (4 tests):
    ● createKoi assembles with discovery provider + loop adapter
    ● Text completion succeeds with provider attached
    ● Lifecycle hooks fire correctly
    ● Multi-middleware composition works

  Cross-cutting (3 tests):
    ● Lifecycle hooks fire alongside tool execution
    ● Agent state transitions (created → terminated)
    ● Multiple middleware layers observe tool calls

  Run: E2E_TESTS=1 ANTHROPIC_API_KEY=... bun test src/__tests__/e2e-full-stack.test.ts
```

### Coverage

75 tests total (64 unit + integration, 11 E2E). Unit tests achieve 80%+ coverage on core modules. E2E tests gated behind `E2E_TESTS=1`.

```bash
# Unit + integration (default)
bun --cwd packages/agent-discovery test

# Everything including real LLM
E2E_TESTS=1 ANTHROPIC_API_KEY=... bun --cwd packages/agent-discovery test
```

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| `SystemCalls` interface for PATH scanning | Enables full mock injection — no real `Bun.which()` in tests |
| `ComponentProvider` pattern | Tools attach via ECS — any engine adapter discovers them with zero engine changes |
| `Promise.allSettled()` for sources | Partial failure: one broken source doesn't block results from the others |
| Dedup priority: MCP > filesystem > PATH | MCP has richer metadata; filesystem is user-explicit; PATH is auto-detected |
| Cache with inflight dedup | Avoids redundant scans during concurrent tool calls in the same turn |
| `discover_agents` as `verified` trust tier | Read-only operation; safe to auto-approve |
| Keyword heuristic for MCP scanner | Low-cost first pass; callers can pre-filter for precision |
| No external dependencies | Zero npm packages beyond `@koi/core`; uses `Bun.which()`, `Bun.spawn()`, `Bun.file()` |
| `EXTERNAL_AGENTS` ECS singleton | Programmatic access for non-LLM consumers (dashboards, monitors, middleware) |
| `.js` extensions in imports | Required by `verbatimModuleSyntax` — ESM-only codebase |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    ExternalAgentDescriptor, ExternalAgentSource,         │
    ExternalAgentTransport, ComponentProvider,             │
    Tool, ToolDescriptor, toolToken, EXTERNAL_AGENTS      │
                                                          │
                                                          ▼
L2  @koi/agent-discovery ◄──────────────────────────────┘
    imports from L0 only (runtime)
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✗ zero external npm dependencies
    ✓ SystemCalls is a plain interface (no vendor types)
    ✓ All interface properties readonly
    ✓ Tool execute returns structured objects (never throws)
    ✓ Engine adapter agnostic (works with Pi, Loop, LangGraph)

Dev-only imports (test files only):
    @koi/engine       — createKoi (E2E assembly)
    @koi/engine-pi    — createPiAdapter (real LLM E2E)
    @koi/engine-loop  — createLoopAdapter (loop adapter E2E)
    @koi/model-router — createAnthropicAdapter (model handler)
```
