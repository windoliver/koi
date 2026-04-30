# `@koi/agent-discovery` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the L2 package `@koi/agent-discovery` — runtime discovery of external coding agents (Claude Code, Aider, Codex, OpenCode, Gemini CLI, custom JSON-registered agents, MCP-connected agents) exposed as both an LLM tool (`discover_agents`) and an ECS singleton (`EXTERNAL_AGENTS`).

**Architecture:** Pure L2 package. One factory `createDiscoveryProvider()` wires three sources (PATH scanner, filesystem scanner, MCP scanner) into a `Discovery` aggregator with TTL cache + inflight dedup + dedup-by-name (priority MCP > FS > PATH), and attaches an LLM tool + ECS component to any agent via `ComponentProvider`. Imports only `@koi/core`. All I/O abstracted behind a `SystemCalls` interface so unit tests inject mocks.

**Tech Stack:** TypeScript 6 strict, Bun 1.3 (`Bun.which`, `Bun.spawn`, `Bun.file`, `Bun.glob`), `bun:test`, tsup, Biome.

**Spec:** `docs/L2/agent-discovery.md` (authoritative).

**Reference (port + simplify):** `archive/v1/packages/observability/agent-discovery/src/`.

**Issue:** #1378 (v2 Phase 3-obs-2).

---

## File Structure

```
packages/lib/agent-discovery/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                       ← public re-exports
    ├── types.ts                       ← SystemCalls, KnownCliAgent, McpAgentSource,
    │                                    DiscoveryFilter, DiscoveryProviderConfig
    ├── constants.ts                   ← KNOWN_CLI_AGENTS (5), DEFAULT_CACHE_TTL_MS,
    │                                    SOURCE_PRIORITY, DEFAULT_HEALTH_TIMEOUT_MS,
    │                                    AGENT_KEYWORDS (mcp scanner)
    ├── system-calls.ts                ← createDefaultSystemCalls() — Bun-backed
    ├── health.ts                      ← checkAgentHealth()
    ├── discovery.ts                   ← createDiscovery() — cache + dedup
    ├── discovery.test.ts
    ├── discover-agents-tool.ts        ← createDiscoverAgentsTool()
    ├── discover-agents-tool.test.ts
    ├── component-provider.ts          ← createDiscoveryProvider()
    ├── component-provider.test.ts
    ├── health.test.ts
    ├── sources/
    │   ├── path-scanner.ts            ← createPathSource()
    │   ├── path-scanner.test.ts
    │   ├── filesystem-scanner.ts      ← createFilesystemSource()
    │   ├── filesystem-scanner.test.ts
    │   ├── mcp-scanner.ts             ← createMcpSource()
    │   └── mcp-scanner.test.ts
    └── __tests__/
        └── integration.test.ts        ← 3 sources → dedup → filter → tool
```

E2E (`e2e-full-stack.test.ts`) listed in spec is **out of scope for this PR** — gated behind `E2E_TESTS=1` and adds ~11 LLM-API tests. Add in a follow-up if needed; v1 reference exists.

---

## Task 1 — Scaffold

**Files:**
- Create: `packages/lib/agent-discovery/{package.json,tsconfig.json,tsup.config.ts,src/index.ts}`

- [ ] **Step 1: Create `package.json`** (same shape as `packages/lib/event-trace/package.json`):

```json
{
  "name": "@koi/agent-discovery",
  "description": "Runtime discovery of external coding agents (CLI, filesystem registry, MCP)",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@koi/core": "workspace:*"
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "lint": "biome check .",
    "test": "bun test"
  },
  "koi": {
    "optional": true
  }
}
```

- [ ] **Step 2: `tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src/**/*"],
  "references": [{ "path": "../../kernel/core" }]
}
```

- [ ] **Step 3: `tsup.config.ts`** — copy from `packages/lib/event-trace/tsup.config.ts`.

- [ ] **Step 4: `src/index.ts`** — `export {};`

- [ ] **Step 5: Verify**

Run: `bun install && bun --cwd packages/lib/agent-discovery run build && bun --cwd packages/lib/agent-discovery run typecheck`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add packages/lib/agent-discovery/
git commit -m "feat(agent-discovery): scaffold L2 package"
```

---

## Task 2 — `types.ts` + `constants.ts` + `SystemCalls`

**Spec section:** "PATH Scanner", "Filesystem Scanner", "MCP Scanner", `DiscoveryProviderConfig` (`docs/L2/agent-discovery.md`).
**V1 reference:** `archive/v1/packages/observability/agent-discovery/src/{types.ts,constants.ts}` and `system-calls` if present.

- [ ] **Step 1: Define `types.ts`** — only types, no logic.

```typescript
import type {
  ExternalAgentDescriptor,
  ExternalAgentTransport,
} from "@koi/core";

/** Inject I/O for testing. Default impl uses Bun.which / Bun.file / Bun.spawn. */
export interface SystemCalls {
  readonly which: (binary: string) => Promise<string | null>;
  readonly readDir: (path: string) => Promise<readonly string[]>;
  readonly readFile: (path: string) => Promise<string>;
  readonly spawn: (
    cmd: readonly string[],
    timeoutMs: number,
  ) => Promise<{ readonly stdout: string; readonly exitCode: number }>;
}

/** Known CLI agent declaration (PATH scanner input). */
export interface KnownCliAgent {
  readonly name: string;
  readonly displayName?: string;
  readonly binaries: readonly string[];      // candidate binary names
  readonly capabilities: readonly string[];
  readonly versionFlag?: string;             // e.g. "--version"
  readonly transport: ExternalAgentTransport;
}

/** MCP server adapter — caller-provided. */
export interface McpAgentSource {
  readonly name: string;
  readonly listTools: () => Promise<{
    readonly ok: true;
    readonly value: readonly { readonly name: string; readonly description?: string }[];
  } | { readonly ok: false; readonly error: { readonly message: string } }>;
}

export interface DiscoveryFilter {
  readonly capability?: string;
  readonly transport?: ExternalAgentTransport;
  readonly source?: "path" | "mcp" | "filesystem";
}

/** A pluggable scan source. */
export interface DiscoverySource {
  readonly id: "path" | "mcp" | "filesystem";
  readonly priority: number;          // lower = higher priority
  readonly discover: () => Promise<readonly ExternalAgentDescriptor[]>;
}

export interface DiscoveryProviderConfig {
  readonly knownAgents?: readonly KnownCliAgent[];
  readonly systemCalls?: SystemCalls;
  readonly registryDir?: string;
  readonly mcpSources?: readonly McpAgentSource[];
  readonly cacheTtlMs?: number;
  readonly healthTimeoutMs?: number;
}

export interface DiscoveryHandle {
  readonly discover: (
    opts?: { readonly filter?: DiscoveryFilter },
  ) => Promise<readonly ExternalAgentDescriptor[]>;
  readonly invalidate: () => void;
}
```

- [ ] **Step 2: Define `constants.ts`** — five known CLI agents per spec table; defaults.

```typescript
import type { KnownCliAgent } from "./types.js";

export const DEFAULT_CACHE_TTL_MS = 60_000;
export const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

export const SOURCE_PRIORITY = {
  mcp: 0,
  filesystem: 1,
  path: 2,
} as const;

export const AGENT_KEYWORDS = [
  "agent",
  "assistant",
  "code",
  "chat",
  "generate",
  "review",
] as const;

export const KNOWN_CLI_AGENTS: readonly KnownCliAgent[] = [
  {
    name: "claude-code",
    displayName: "Claude Code",
    binaries: ["claude"],
    capabilities: ["code-generation", "code-review", "debugging", "refactoring"],
    versionFlag: "--version",
    transport: "cli",
  },
  {
    name: "codex",
    displayName: "OpenAI Codex CLI",
    binaries: ["codex"],
    capabilities: ["code-generation", "debugging"],
    versionFlag: "--version",
    transport: "cli",
  },
  {
    name: "aider",
    displayName: "Aider",
    binaries: ["aider"],
    capabilities: ["code-generation", "code-review", "refactoring"],
    versionFlag: "--version",
    transport: "cli",
  },
  {
    name: "opencode",
    displayName: "OpenCode",
    binaries: ["opencode"],
    capabilities: ["code-generation", "debugging"],
    versionFlag: "--version",
    transport: "cli",
  },
  {
    name: "gemini-cli",
    displayName: "Gemini CLI",
    binaries: ["gemini"],
    capabilities: ["code-generation", "code-review"],
    versionFlag: "--version",
    transport: "cli",
  },
];
```

- [ ] **Step 3: Define `system-calls.ts`** — Bun-backed defaults; never imported by tests.

```typescript
import type { SystemCalls } from "./types.js";

export function createDefaultSystemCalls(): SystemCalls {
  return {
    which: async (b) => {
      const path = Bun.which(b);
      return path ?? null;
    },
    readDir: async (path) => {
      const glob = new Bun.Glob("*.json");
      return [...glob.scanSync({ cwd: path, onlyFiles: true })];
    },
    readFile: async (path) => Bun.file(path).text(),
    spawn: async (cmd, timeoutMs) => {
      const proc = Bun.spawn({
        cmd: [...cmd],
        stdout: "pipe",
        stderr: "ignore",
        timeout: timeoutMs,
      });
      const stdout = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { stdout, exitCode };
    },
  };
}
```

- [ ] **Step 4: Typecheck**

Run: `bun --cwd packages/lib/agent-discovery run typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add packages/lib/agent-discovery/src/{types.ts,constants.ts,system-calls.ts}
git commit -m "feat(agent-discovery): types, constants, default SystemCalls"
```

---

## Task 3 — `health.ts`

**Spec section:** `checkAgentHealth(agent, systemCalls, timeoutMs?)`.

- [ ] **Step 1: Write the test** `health.test.ts`

```typescript
import { describe, expect, test } from "bun:test";
import { checkAgentHealth } from "./health.js";
import type { SystemCalls } from "./types.js";
import type { ExternalAgentDescriptor } from "@koi/core";

function makeSc(over: Partial<SystemCalls> = {}): SystemCalls {
  return {
    which: async () => null,
    readDir: async () => [],
    readFile: async () => "",
    spawn: async () => ({ stdout: "", exitCode: 0 }),
    ...over,
  };
}

const cli: ExternalAgentDescriptor = {
  name: "x",
  transport: "cli",
  command: "x",
  capabilities: [],
  source: "path",
};

describe("checkAgentHealth", () => {
  test("CLI healthy when --version exits 0", async () => {
    const sc = makeSc({ spawn: async () => ({ stdout: "1.0.0", exitCode: 0 }) });
    const r = await checkAgentHealth(cli, sc);
    expect(r.status).toBe("healthy");
    expect(typeof r.latencyMs).toBe("number");
  });

  test("CLI unhealthy when --version exits non-zero", async () => {
    const sc = makeSc({ spawn: async () => ({ stdout: "", exitCode: 1 }) });
    const r = await checkAgentHealth(cli, sc);
    expect(r.status).toBe("unhealthy");
  });

  test("CLI unhealthy when spawn throws", async () => {
    const sc = makeSc({ spawn: async () => { throw new Error("boom"); } });
    const r = await checkAgentHealth(cli, sc);
    expect(r.status).toBe("unhealthy");
    expect(r.message).toMatch(/boom/);
  });

  test("non-CLI returns unknown", async () => {
    const r = await checkAgentHealth({ ...cli, transport: "mcp", source: "mcp" }, makeSc());
    expect(r.status).toBe("unknown");
  });
});
```

- [ ] **Step 2: Verify failure** — `bun --cwd packages/lib/agent-discovery test health` — fails (no module).

- [ ] **Step 3: Implement `health.ts`**

```typescript
import type { ExternalAgentDescriptor } from "@koi/core";
import { DEFAULT_HEALTH_TIMEOUT_MS } from "./constants.js";
import type { SystemCalls } from "./types.js";

export interface HealthResult {
  readonly status: "healthy" | "unhealthy" | "unknown";
  readonly latencyMs: number;
  readonly message?: string;
}

export async function checkAgentHealth(
  agent: ExternalAgentDescriptor,
  sc: SystemCalls,
  timeoutMs: number = DEFAULT_HEALTH_TIMEOUT_MS,
): Promise<HealthResult> {
  if (agent.transport !== "cli" || !agent.command) {
    return { status: "unknown", latencyMs: 0 };
  }
  const start = performance.now();
  try {
    const { exitCode } = await sc.spawn([agent.command, "--version"], timeoutMs);
    return {
      status: exitCode === 0 ? "healthy" : "unhealthy",
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (e: unknown) {
    return {
      status: "unhealthy",
      latencyMs: Math.round(performance.now() - start),
      message: e instanceof Error ? e.message : String(e),
    };
  }
}
```

- [ ] **Step 4: Tests pass.** Commit:

```bash
git add packages/lib/agent-discovery/src/health.ts packages/lib/agent-discovery/src/health.test.ts
git commit -m "feat(agent-discovery): checkAgentHealth"
```

---

## Task 4 — PATH scanner

**Spec section:** "PATH Scanner".
**V1 reference:** `archive/v1/packages/observability/agent-discovery/src/sources/path-scanner.ts`.

- [ ] **Step 1: Write `sources/path-scanner.test.ts`** with at least these scenarios:

1. Returns descriptors for each `KnownCliAgent` whose binary resolves via `which`.
2. Skips agents whose binaries do not resolve (returns nothing for them).
3. Tries multiple binaries per agent — first hit wins.
4. Custom `knownAgents` config replaces default list.
5. Sets `transport: "cli"`, `source: "path"`, `command: <resolved binary name>`, `healthy: true`.

Use a fake `SystemCalls` that returns `which: async (b) => b === "claude" ? "/usr/local/bin/claude" : null`.

- [ ] **Step 2: Confirm failure.**

- [ ] **Step 3: Implement** — port from v1, simplified:

```typescript
import type { ExternalAgentDescriptor } from "@koi/core";
import { KNOWN_CLI_AGENTS, SOURCE_PRIORITY } from "../constants.js";
import { createDefaultSystemCalls } from "../system-calls.js";
import type { DiscoverySource, KnownCliAgent, SystemCalls } from "../types.js";

export interface PathSourceConfig {
  readonly knownAgents?: readonly KnownCliAgent[];
  readonly systemCalls?: SystemCalls;
}

export function createPathSource(config: PathSourceConfig = {}): DiscoverySource {
  const knownAgents = config.knownAgents ?? KNOWN_CLI_AGENTS;
  const sc = config.systemCalls ?? createDefaultSystemCalls();

  return {
    id: "path",
    priority: SOURCE_PRIORITY.path,
    discover: async (): Promise<readonly ExternalAgentDescriptor[]> => {
      const results: ExternalAgentDescriptor[] = [];
      for (const agent of knownAgents) {
        for (const bin of agent.binaries) {
          const path = await sc.which(bin);
          if (path) {
            results.push({
              name: agent.name,
              displayName: agent.displayName,
              transport: agent.transport,
              command: bin,
              capabilities: agent.capabilities,
              healthy: true,
              source: "path",
            });
            break;
          }
        }
      }
      return results;
    },
  };
}
```

- [ ] **Step 4: Tests pass.** Commit.

```bash
git add packages/lib/agent-discovery/src/sources/path-scanner.{ts,test.ts}
git commit -m "feat(agent-discovery): PATH scanner"
```

---

## Task 5 — Filesystem scanner

**Spec section:** "Filesystem Scanner". Keys: missing dir → empty (no throw); invalid JSON → skip + `onSkip` callback; path-traversal blocked.

**V1 reference:** `archive/v1/packages/observability/agent-discovery/src/sources/filesystem-scanner.ts`.

- [ ] **Step 1: Write `sources/filesystem-scanner.test.ts`** — scenarios:

1. Reads valid `*.json` files into descriptors with `source: "filesystem"`.
2. Missing dir returns empty array (no throw).
3. Invalid JSON is skipped; `onSkip` callback called with reason.
4. JSON missing required fields is skipped; `onSkip` called.
5. Path traversal in directory path (e.g. `~/.koi/agents/../../etc`) — resolved and blocked (or thrown VALIDATION).
6. Tilde expansion: `~/foo` resolves via `os.homedir()`.

Use a fake `SystemCalls` that backs `readDir` + `readFile` with an in-memory map.

- [ ] **Step 2: Implement** — port from v1, adapt error handling.

Skeleton highlights:
- Accepts either `string` (registryDir) or `{ registryDir, onSkip }`.
- Resolves `~` via `import { homedir } from "node:os"` (allowed — node built-in).
- After resolution, ensures the path does not contain `..` segments. If it does, throw `VALIDATION` error.
- Uses `sc.readDir(dir)` then `sc.readFile(join(dir, file))` for each `.json`.
- Validates each file has `name`, `transport`, `capabilities`. Sets `source: "filesystem"`.

- [ ] **Step 3: Tests pass.** Commit.

```bash
git add packages/lib/agent-discovery/src/sources/filesystem-scanner.{ts,test.ts}
git commit -m "feat(agent-discovery): filesystem scanner"
```

---

## Task 6 — MCP scanner

**Spec section:** "MCP Scanner". Keyword heuristic over `name` + `description` ⇒ qualifies a server.

- [ ] **Step 1: Write `sources/mcp-scanner.test.ts`** — scenarios:

1. Server whose any tool name/description matches `AGENT_KEYWORDS` produces one descriptor.
2. Server with no qualifying tools produces nothing.
3. `listTools` returning `{ ok: false }` is skipped (does not throw).
4. Multiple servers, mixed pass/fail — only qualifying ones returned.

- [ ] **Step 2: Implement**

```typescript
import type { ExternalAgentDescriptor } from "@koi/core";
import { AGENT_KEYWORDS, SOURCE_PRIORITY } from "../constants.js";
import type { DiscoverySource, McpAgentSource } from "../types.js";

function qualifies(text: string | undefined): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  return AGENT_KEYWORDS.some((k) => t.includes(k));
}

export function createMcpSource(managers: readonly McpAgentSource[]): DiscoverySource {
  return {
    id: "mcp",
    priority: SOURCE_PRIORITY.mcp,
    discover: async (): Promise<readonly ExternalAgentDescriptor[]> => {
      const out: ExternalAgentDescriptor[] = [];
      for (const m of managers) {
        const r = await m.listTools();
        if (!r.ok) continue;
        const matched = r.value.some(
          (t) => qualifies(t.name) || qualifies(t.description),
        );
        if (matched) {
          out.push({
            name: m.name,
            transport: "mcp",
            capabilities: ["code-generation"],
            healthy: true,
            source: "mcp",
            metadata: { tools: r.value.map((t) => t.name) },
          });
        }
      }
      return out;
    },
  };
}
```

- [ ] **Step 3: Tests pass.** Commit.

---

## Task 7 — `discovery.ts` (aggregator: cache + dedup + filter + partial failure)

**Spec section:** "Caching", "Deduplication", `createDiscovery`.

- [ ] **Step 1: Write `discovery.test.ts`** — scenarios:

1. `discover()` calls `Promise.allSettled` over sources; one rejected source does not block others.
2. Result is cached; second call within TTL returns same array reference (or equivalent value) without re-calling sources. Use a counter on a fake source.
3. `invalidate()` clears the cache; next call re-fetches.
4. Inflight dedup: two concurrent calls share one fetch (fake source increments counter once).
5. Dedup-by-name: same `name` from PATH and MCP — MCP wins (priority 0 < 2).
6. Filter by `transport: "cli"` removes non-CLI agents.
7. Filter by `source: "mcp"` removes non-MCP descriptors.
8. Filter by `capability: "code-review"` removes descriptors lacking it.

- [ ] **Step 2: Implement**

```typescript
import type { ExternalAgentDescriptor } from "@koi/core";
import type { DiscoveryFilter, DiscoveryHandle, DiscoverySource } from "./types.js";

interface CacheState {
  readonly value: readonly ExternalAgentDescriptor[];
  readonly expiresAt: number;
}

export function createDiscovery(
  sources: readonly DiscoverySource[],
  cacheTtlMs: number,
): DiscoveryHandle {
  let cache: CacheState | null = null;
  let inflight: Promise<readonly ExternalAgentDescriptor[]> | null = null;

  function dedupByName(
    descriptors: readonly ExternalAgentDescriptor[],
  ): readonly ExternalAgentDescriptor[] {
    const byName = new Map<string, { d: ExternalAgentDescriptor; pri: number }>();
    for (const d of descriptors) {
      const sourcePri = sources.find((s) => s.id === d.source)?.priority ?? 99;
      const existing = byName.get(d.name);
      if (!existing || sourcePri < existing.pri) {
        byName.set(d.name, { d, pri: sourcePri });
      }
    }
    return [...byName.values()].map((v) => v.d);
  }

  async function fetchAll(): Promise<readonly ExternalAgentDescriptor[]> {
    const settled = await Promise.allSettled(sources.map((s) => s.discover()));
    const flat: ExternalAgentDescriptor[] = [];
    for (const r of settled) {
      if (r.status === "fulfilled") flat.push(...r.value);
    }
    return dedupByName(flat);
  }

  function applyFilter(
    arr: readonly ExternalAgentDescriptor[],
    f?: DiscoveryFilter,
  ): readonly ExternalAgentDescriptor[] {
    if (!f) return arr;
    return arr.filter((d) => {
      if (f.transport && d.transport !== f.transport) return false;
      if (f.source && d.source !== f.source) return false;
      if (f.capability && !d.capabilities.includes(f.capability)) return false;
      return true;
    });
  }

  return {
    async discover(opts) {
      if (cache && cache.expiresAt > Date.now()) {
        return applyFilter(cache.value, opts?.filter);
      }
      if (inflight) {
        const value = await inflight;
        return applyFilter(value, opts?.filter);
      }
      inflight = fetchAll();
      try {
        const value = await inflight;
        cache = { value, expiresAt: Date.now() + cacheTtlMs };
        return applyFilter(value, opts?.filter);
      } finally {
        inflight = null;
      }
    },
    invalidate() {
      cache = null;
    },
  };
}
```

- [ ] **Step 3: Tests pass.** Commit.

---

## Task 8 — `discover_agents` tool

**Spec section:** "Tool: discover_agents".

- [ ] **Step 1: Write `discover-agents-tool.test.ts`** — scenarios:

1. Descriptor has `name: "discover_agents"`, `trustTier: "verified"` (or whatever the L0 type uses), inputSchema with optional `capability/transport/source`.
2. `execute({})` returns `{ agents: [...], count: N }` where N matches.
3. `execute({ transport: "cli" })` filters correctly.
4. `execute()` never throws — internal source error → empty agents (verified by feeding a `Discovery` whose `discover()` rejects).

- [ ] **Step 2: Implement**

Look up exact `Tool` / `ToolDescriptor` shape in `packages/kernel/core/src/{ecs.ts,external-agent.ts}` before writing. Skeleton:

```typescript
import type { Tool, ToolDescriptor } from "@koi/core";
import type { DiscoveryFilter, DiscoveryHandle } from "./types.js";

const DESCRIPTOR: ToolDescriptor = {
  name: "discover_agents",
  description: "Discover external coding agents available on the host machine",
  trustTier: "verified",                   // confirm from L0
  inputSchema: {
    type: "object",
    properties: {
      capability: { type: "string" },
      transport: { type: "string", enum: ["cli", "mcp", "a2a"] },
      source: { type: "string", enum: ["path", "mcp", "filesystem"] },
    },
    additionalProperties: false,
  },
};

export function createDiscoverAgentsTool(discovery: DiscoveryHandle): Tool {
  return {
    descriptor: DESCRIPTOR,
    execute: async (input: unknown) => {
      const f = (input ?? {}) as DiscoveryFilter;
      try {
        const agents = await discovery.discover({ filter: f });
        return { agents, count: agents.length };
      } catch {
        return { agents: [], count: 0 };
      }
    },
  };
}
```

  Adjust `Tool` / `ToolDescriptor` field names to match the live L0 contract — do not invent shapes.

- [ ] **Step 3: Tests pass.** Commit.

---

## Task 9 — `createDiscoveryProvider` (`ComponentProvider`)

**Spec section:** API → `createDiscoveryProvider(config?)`.

- [ ] **Step 1: Write `component-provider.test.ts`** — scenarios:

1. Provider's `attach(agent)` returns a map containing `toolToken("discover_agents") → Tool` and `EXTERNAL_AGENTS → readonly ExternalAgentDescriptor[]`.
2. Tool resolved from the attached map executes and returns `{ agents, count }`.
3. Custom `knownAgents`, `registryDir`, `mcpSources` are wired into the underlying sources.
4. If no `mcpSources` provided, MCP source contributes nothing.
5. Custom `cacheTtlMs` is honored (verifiable via spy on a fake source).

- [ ] **Step 2: Implement**

```typescript
import type { ComponentProvider, ExternalAgentDescriptor } from "@koi/core";
import { EXTERNAL_AGENTS, toolToken } from "@koi/core";
import { DEFAULT_CACHE_TTL_MS } from "./constants.js";
import { createDiscovery } from "./discovery.js";
import { createDiscoverAgentsTool } from "./discover-agents-tool.js";
import { createPathSource } from "./sources/path-scanner.js";
import { createFilesystemSource } from "./sources/filesystem-scanner.js";
import { createMcpSource } from "./sources/mcp-scanner.js";
import type { DiscoveryProviderConfig } from "./types.js";

export function createDiscoveryProvider(
  config: DiscoveryProviderConfig = {},
): ComponentProvider {
  const sources = [
    createPathSource({
      knownAgents: config.knownAgents,
      systemCalls: config.systemCalls,
    }),
    ...(config.registryDir
      ? [createFilesystemSource(config.registryDir)]
      : []),
    ...(config.mcpSources?.length
      ? [createMcpSource(config.mcpSources)]
      : []),
  ];
  const discovery = createDiscovery(
    sources,
    config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS,
  );
  const tool = createDiscoverAgentsTool(discovery);

  return {
    name: "agent-discovery",
    attach: async () => {
      const agents: readonly ExternalAgentDescriptor[] = await discovery.discover();
      return new Map<symbol, unknown>([
        [toolToken("discover_agents"), tool],
        [EXTERNAL_AGENTS, agents],
      ]);
    },
  };
}
```

  Adjust to the exact `ComponentProvider` shape in L0 — confirm before final implementation. The two ECS-key plus one tool token should work; replace `Map<symbol, unknown>` with the exact return type expected.

- [ ] **Step 3: Tests pass.** Commit.

---

## Task 10 — Integration test

- [ ] **Step 1:** Create `src/__tests__/integration.test.ts`. Wire all three sources (with mock `SystemCalls`, mock MCP managers, real `tmpdir()` for filesystem) end-to-end through `createDiscoveryProvider`. Assert:

1. All 3 sources contribute descriptors.
2. Dedup correctly prefers MCP over filesystem over PATH for shared name.
3. Filter applies to the tool's output.
4. Partial failure (broken MCP source rejecting) does not block PATH/filesystem.

- [ ] **Step 2: Tests pass.** Commit.

---

## Task 11 — Index exports + repo gates

- [ ] **Step 1: Update `src/index.ts`**

```typescript
export { createDiscoveryProvider } from "./component-provider.js";
export { createDiscovery } from "./discovery.js";
export { createDiscoverAgentsTool } from "./discover-agents-tool.js";
export { createPathSource } from "./sources/path-scanner.js";
export { createFilesystemSource } from "./sources/filesystem-scanner.js";
export { createMcpSource } from "./sources/mcp-scanner.js";
export { checkAgentHealth } from "./health.js";
export { KNOWN_CLI_AGENTS, DEFAULT_CACHE_TTL_MS } from "./constants.js";
export type {
  DiscoveryProviderConfig,
  DiscoveryHandle,
  DiscoveryFilter,
  DiscoverySource,
  KnownCliAgent,
  McpAgentSource,
  SystemCalls,
} from "./types.js";
export type { HealthResult } from "./health.js";
```

- [ ] **Step 2: Repo gates**

```bash
bun --cwd packages/lib/agent-discovery test
bun --cwd packages/lib/agent-discovery run typecheck
bun --cwd packages/lib/agent-discovery run build
bun --cwd packages/lib/agent-discovery run lint
bun run check:layers
bun run check:unused
bun run check:duplicates
```

All exit 0.

- [ ] **Step 3: Commit any cleanups.**

---

## Task 12 — Wire to `@koi/runtime` (golden coverage)

**Files:**
- Modify: `packages/meta/runtime/package.json` (add dep)
- Modify: `packages/meta/runtime/tsconfig.json` (add reference)
- Modify: `packages/meta/runtime/src/__tests__/golden-replay.test.ts`
- (Optional) Modify: `packages/meta/runtime/scripts/record-cassettes.ts` to add a `discovery` query for cassette + trajectory

- [ ] **Step 1: Add dep + tsconfig reference.** Run `bun install` after edits.

- [ ] **Step 2: Add 2 LLM-free golden tests** in `golden-replay.test.ts`:

```typescript
describe("Golden: @koi/agent-discovery", () => {
  test("createDiscoveryProvider produces discover_agents tool", async () => {
    const { createDiscoveryProvider } = await import("@koi/agent-discovery");
    const { toolToken } = await import("@koi/core");
    const fakeSc = {
      which: async (b: string) => (b === "claude" ? "/usr/local/bin/claude" : null),
      readDir: async () => [],
      readFile: async () => "",
      spawn: async () => ({ stdout: "", exitCode: 0 }),
    };
    const provider = createDiscoveryProvider({ systemCalls: fakeSc });
    const components = await provider.attach(/* fake agent — adjust to L0 shape */);
    expect(components.has(toolToken("discover_agents"))).toBe(true);
  });

  test("dedup: MCP source wins over PATH for shared name", async () => {
    // Wire two sources contributing the same `name`, one PATH one MCP.
    // Assert MCP descriptor is the survivor.
  });
});
```

- [ ] **Step 3: Cassette/trajectory** — only required if a real LLM call exercises `discover_agents`. If skipping, add a comment in the file pointing at this PR.

- [ ] **Step 4: Run runtime tests + orphan/golden checks**

```bash
bun --cwd packages/meta/runtime test
bun run check:orphans
bun run check:golden-queries
```

- [ ] **Step 5: Commit.**

```bash
git add packages/meta/runtime/
git commit -m "test(runtime): golden coverage for @koi/agent-discovery"
```

---

## Task 13 — PR

- [ ] **Step 1:** Push, open PR titled `feat(agent-discovery): runtime discovery of external coding agents (#1378)`. Body summarises 3 sources, dedup priority, ECS exposure, cache, and lists files added. Test plan mirrors Task 11 commands.
