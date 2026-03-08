# koi — Single-Package Distribution (L4)

One package to install, one import to start. `koi` absorbs all 20 L3 meta-packages and ~28 orphaned L2 packages into a single distribution with subpath exports and lazy-loaded optional dependencies.

---

## What This Feature Enables

### 1. One Install, One Import

Before: consumers composed 5-10 `@koi/*` packages manually to build an agent. Every successful agent framework (Vercel AI SDK, CrewAI, Mastra, OpenAI Agents) ships a single package. Now Koi does too.

```bash
# Before (5+ installs, fragile version coordination)
bun add @koi/core @koi/engine @koi/engine-pi @koi/starter @koi/manifest @koi/channels @koi/sandbox-stack

# After (one install)
bun add koi
```

```typescript
// Before
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { loadManifest } from "@koi/manifest";

// After — identical API, single package
import { createKoi, createPiAdapter, loadManifest } from "koi";
```

### 2. Subpath Exports for Progressive Disclosure

The root export covers 90% of use cases (create agent, load manifest, stream). Advanced capabilities are available via subpaths — you only import what you need:

```typescript
// Core agent creation (root)
import { createKoi, createPiAdapter, loadManifest } from "koi";

// Add channels when needed
import { createChannelStack } from "koi/channels";

// Add sandbox when needed
import { createSandboxStack } from "koi/sandbox";

// Add middleware when needed
import { createReportMiddleware, createReflexMiddleware } from "koi/middleware";

// Add tools when needed
import { createWebProvider, createGithubProvider } from "koi/tools";
```

### 3. Engine-Pi as Default

The Pi engine (streaming-first, multi-turn, tool-calling) is the default engine — it works out of the box with no additional installs. `createPiAdapter` is exported from the root:

```typescript
import { createKoi, createPiAdapter, loadManifest } from "koi";

const { manifest } = (await loadManifest("koi.yaml")).value;

const adapter = createPiAdapter({
  model: manifest.model.name,
  systemPrompt: "You are a helpful assistant.",
  getApiKey: async () => process.env.ANTHROPIC_API_KEY ?? "",
});

const runtime = await createKoi({ manifest, adapter });

for await (const event of runtime.run({ kind: "text", text: "Hello!" })) {
  if (event.kind === "text_delta") process.stdout.write(event.delta);
}

await runtime.dispose();
```

### 4. Lazy-Loaded Heavy Dependencies

Channel adapters (Discord, Slack, Telegram, etc.) and cloud sandbox backends (Docker, E2B, Cloudflare, etc.) are **not** loaded at import time. They use dynamic `import()` shims that only resolve when the adapter is actually created:

```
import { createChannelStack } from "koi/channels";
       │
       ├── Imports registry + types (lightweight, ~6 KB)
       │
       └── Does NOT import discord.js, grammy, livekit, etc.
           │
           └── Only imported when:
               createChannelStack({ channels: [{ name: "discord" }] })
               triggers dynamic import("@koi/channel-discord")
```

If the optional dependency isn't installed, the shim throws an actionable error:

```
Error: To use the Discord channel, install: bun add @koi/channel-discord
```

### 5. No Version Coordination

All internal packages use `workspace:*` — there's a single version to track. No more mismatched `@koi/core@0.3.2` with `@koi/engine@0.3.1` breakage.

### 6. Full Middleware Chain Validated

The entire pipeline is E2E tested with a real LLM (OpenRouter → Gemini):
- Text streaming through `createKoi + createPiAdapter`
- Tool calls with middleware interception (`wrapToolCall`)
- Model stream interception (`wrapModelStream`)
- Lifecycle hooks (`onSessionStart`, `onAfterTurn`, `onSessionEnd`)
- Multi-tool conversations
- Metrics accumulation across tool turns
- Manifest loading → runtime assembly

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  koi  (L4 — distribution layer)                             │
│                                                             │
│  Root:  createKoi, createPiAdapter, loadManifest,           │
│         createConfiguredKoi, core types                     │
│                                                             │
│  ┌───────────────────┐  ┌────────────────────────────────┐  │
│  │ L3 Subpaths (19)  │  │ Orphaned L2 Domain Groups (5) │  │
│  │                   │  │                                │  │
│  │ koi/channels      │  │ koi/tools      — MCP, web,    │  │
│  │ koi/sandbox       │  │                  github, exec  │  │
│  │ koi/forge         │  │ koi/infra      — config,      │  │
│  │ koi/gateway       │  │                  scheduler,    │  │
│  │ koi/goals         │  │                  search, store │  │
│  │ koi/governance    │  │ koi/safety     — eval, doctor, │  │
│  │ koi/nexus         │  │                  self-test,    │  │
│  │ koi/ipc           │  │                  verified-loop │  │
│  │ koi/node          │  │ koi/middleware — event-trace,  │  │
│  │ koi/workspace     │  │                  report,       │  │
│  │ koi/skills        │  │                  reflex, rules │  │
│  │ koi/autonomous    │  │ koi/observability — dashboard, │  │
│  │ koi/quality       │  │                    webhooks,   │  │
│  │ koi/retry         │  │                    transcript, │  │
│  │ koi/rlm           │  │                    bundle      │  │
│  │ koi/context-arena │  └────────────────────────────────┘  │
│  │ koi/tool-stack    │                                      │
│  │ koi/cli           │                                      │
│  │ koi/spawner       │                                      │
│  └───────────────────┘                                      │
│                                                             │
├─────────────────────────────────────────────────────────────┤
│  Dependencies                                               │
│                                                             │
│  Prod: 20 L3 + ~28 orphaned L2 + @koi/engine-pi           │
│  Dev:  @koi/test-utils only                                 │
│                                                             │
│  Lazy-loaded (user installs on demand):                     │
│    14 channel adapters, 5 cloud sandbox backends,           │
│    browser-playwright, dashboard-ui, canvas,                │
│    alternative engines (claude, acp, rlm, external)         │
└─────────────────────────────────────────────────────────────┘
```

### Layer Position

```
L0   @koi/core              Types and contracts
L0u  37 utility packages    Pure functions on L0 types
L1   @koi/engine            Kernel runtime
L2   ~217 feature packages  Independent implementations
L3   20 meta-packages       Convenience bundles (L0 + L1 + L2)
L4   koi                    Distribution (L3 + orphaned L2) ← NEW
```

L4 has no new logic — it is purely re-exports. The layer check enforces this: `scripts/check-layers.ts` skips L4 packages the same way it skips L3.

---

## Subpath Reference

### Root (`koi`)

Starter + engine + core types + manifest. Covers the common "create and run an agent" workflow.

| Export | Source | Kind |
|--------|--------|------|
| `createKoi` | `@koi/engine` | function |
| `createPiAdapter` | `@koi/engine-pi` | function |
| `createConfiguredKoi` | `@koi/starter` | function |
| `createDefaultRegistry` | `@koi/starter` | function |
| `createLocalBackends` | `@koi/starter` | function |
| `loadManifest` | `@koi/manifest` | function |
| `getEngineName` | `@koi/manifest` | function |
| `Agent`, `KoiMiddleware`, `EngineAdapter`, ... | `@koi/core` | type |

### L3 Subpaths

Each re-exports the corresponding L3 meta-package verbatim:

| Subpath | Source Package | Domain |
|---------|---------------|--------|
| `koi/autonomous` | `@koi/autonomous` | Autonomous agent execution |
| `koi/channels` | `@koi/channels` | Channel adapter registry |
| `koi/cli` | `@koi/cli` | CLI commands |
| `koi/context-arena` | `@koi/context-arena` | Context window management |
| `koi/forge` | `@koi/forge` | Self-extending agent forge |
| `koi/gateway` | `@koi/gateway-stack` | Gateway routing |
| `koi/goals` | `@koi/goal-stack` | Goal tracking |
| `koi/governance` | `@koi/governance` | Policy and permissions |
| `koi/ipc` | `@koi/ipc-stack` + `@koi/handoff` + `@koi/name-service` | Inter-process communication |
| `koi/nexus` | `@koi/nexus` | Nexus integration |
| `koi/node` | `@koi/node-stack` | Distributed node runtime |
| `koi/quality` | `@koi/quality-gate` | Quality gate checks |
| `koi/retry` | `@koi/retry-stack` | Retry and recovery |
| `koi/rlm` | `@koi/rlm-stack` | Reinforcement learning |
| `koi/sandbox` | `@koi/sandbox-stack` | Sandboxed code execution |
| `koi/skills` | `@koi/skill-stack` | Skill management |
| `koi/spawner` | `@koi/agent-spawner` | Agent spawning |
| `koi/tool-stack` | `@koi/tool-stack` | Tool composition |
| `koi/workspace` | `@koi/workspace-stack` | Workspace management |

### Orphaned L2 Domain Subpaths

These group L2 packages that weren't covered by any L3 meta-package:

| Subpath | Packages Included |
|---------|------------------|
| `koi/tools` | `@koi/mcp`, `@koi/mcp-server`, `@koi/tools-web`, `@koi/tools-github`, `@koi/tool-ask-user`, `@koi/tool-ask-guide`, `@koi/tool-exec`, `@koi/code-mode` |
| `koi/infra` | `@koi/config`, `@koi/scheduler`, `@koi/scheduler-provider`, `@koi/session-store`, `@koi/search`, `@koi/search-brave` |
| `koi/safety` | `@koi/eval`, `@koi/verified-loop`, `@koi/self-test`, `@koi/doctor` |
| `koi/middleware` | `@koi/middleware-event-trace`, `@koi/middleware-report`, `@koi/middleware-collective-memory`, `@koi/middleware-reflex`, `@koi/middleware-event-rules` |
| `koi/observability` | `@koi/dashboard-api`, `@koi/webhook-delivery`, `@koi/webhook-provider`, `@koi/transcript`, `@koi/bundle` |

Export collisions are resolved with domain-prefixed aliases:

| Collision | Resolution |
|-----------|-----------|
| `DEFAULT_TIMEOUT_MS` (web, exec) | `WEB_DEFAULT_TIMEOUT_MS`, `EXEC_DEFAULT_TIMEOUT_MS` |
| `DEFAULT_PREFIX` (web, github) | `WEB_DEFAULT_PREFIX`, `GITHUB_DEFAULT_PREFIX` |
| `McpServerConfig` (mcp, mcp-server) | `McpServerInstanceConfig` (from mcp-server) |
| `descriptor` (report, reflex, event-rules) | `reportDescriptor`, `reflexDescriptor`, `eventRulesDescriptor` |
| `descriptor` (search-brave) | `braveSearchDescriptor` |

---

## Lazy-Load Shim Pattern

Heavy optional dependencies use a shim pattern for zero-cost imports:

```
packages/meta/channels/src/adapters/discord.ts    (shim)
packages/meta/sandbox-stack/src/adapters/docker.ts (shim)
```

```typescript
// Shim pattern (actual code from channels/adapters/discord.ts)
export async function createDiscordChannel(config: unknown) {
  try {
    const { createDiscordChannel } = await import("@koi/channel-discord");
    return createDiscordChannel(config);
  } catch (error: unknown) {
    throw new Error(
      "To use the Discord channel, install: bun add @koi/channel-discord",
      { cause: error },
    );
  }
}
```

This pattern is applied to:
- **14 channel adapters**: discord, slack, telegram, email, whatsapp, teams, matrix, signal, voice, mobile, canvas-fallback, cli, chat-sdk, agui
- **5 cloud sandbox backends**: docker, e2b, cloudflare, daytona, vercel

---

## Performance

### Import Cost

The root export (`import { createKoi } from "koi"`) loads only:
- `@koi/engine` — kernel runtime (~15 KB)
- `@koi/starter` — registry + factory (~8 KB)
- `@koi/manifest` — YAML parser (~12 KB)
- `@koi/engine-pi` — default engine adapter (~20 KB)
- `@koi/core` — types only (zero runtime cost)

Subpath imports are code-split by tsup — importing `koi/channels` does not load `koi/sandbox` or any other subpath.

### Bundle

```
tsup config: multi-entry, ESM, code-splitting enabled, treeshake, target node22
```

Each subpath produces its own chunk. Shared code (primarily `@koi/core` types) is deduplicated into shared chunks automatically.

### No Eager Heavy Deps

Channel adapters (discord.js ~1.2 MB, grammy ~400 KB) and cloud sandbox SDKs are never loaded unless explicitly used. The `import()` boundary ensures tree-shaking works at the package level.

---

## Testing

```
api-surface.test.ts     — Validates all 26 subpath exports produce stable .d.ts surfaces
composition.test.ts     — Imports from each subpath, verifies key exports exist
lazy-load.test.ts       — Verifies shim functions are accessible, error format correct
e2e-full-stack.test.ts  — 8 tests with real LLM (OpenRouter) through full pipeline
```

```bash
# Unit + composition tests
bun test --cwd packages/meta/koi

# E2E with real LLM (requires OPENROUTER_API_KEY)
E2E_TESTS=1 bun test src/__tests__/e2e-full-stack.test.ts --cwd packages/meta/koi
```

---

## Related Issues

- #885: Create koi L4 package
- #888: Fix scripts/layers.ts (add agent-spawner, L4 layer)
- #889: Bundle orphaned L2 packages
- #890: Lazy-load heavy deps
- #892: Correct orphaned L2 list
- #895: Engine-pi as default

---

## Related Docs

- [Channel Lazy Loading](../channel-lazy-loading.md) — Dynamic descriptor discovery
- [Sandbox Stack](../L3/sandbox-stack.md) — Unified sandbox composition
- [Channels](../L3/channels.md) — Channel adapter registry
