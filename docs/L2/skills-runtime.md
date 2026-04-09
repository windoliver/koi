# @koi/skills-runtime

**Layer:** L2  
**Location:** `packages/lib/skills-runtime`  
**Purpose:** Multi-source skill discovery and loading for Koi agents.

Discovers SKILL.md files from three source tiers (bundled, user, project), enforces project-wins precedence, security-scans each skill's code blocks, and provides progressive loading with an in-memory queryable registry.

## Architecture

```
createSkillsRuntime(config)
  ├── discover()      ← walks roots, reads frontmatter → Map<string, SkillMetadata>
  ├── load(name)      ← full body + security scan → SkillDefinition
  ├── loadAll()       ← load all in parallel → Result<Map, KoiError>
  ├── query(filter?)  ← filter metadata by tags/source/capability (AND semantics)
  └── invalidate(name?) ← cache control (name = body only, no arg = full reset)
```

### Progressive Loading (two-phase)

`discover()` reads YAML frontmatter only — returns `SkillMetadata` with name, description, tags, allowedTools, source, and dirPath. No body is parsed, no security scan runs. This is fast and suitable for listing/filtering.

`load(name)` promotes a discovered skill to `SkillDefinition` by reading the full body, resolving includes, and running the security scanner. Results are cached.

### Concurrency Safety

Both `discover()` and `load()` use inflight promise deduplication. Concurrent callers for the same resource join a single in-flight operation rather than triggering duplicate filesystem scans.

### Three-Source Precedence

Skills are discovered from three tiers, in priority order (highest first):

| Tier | Default path | Priority |
|------|-------------|----------|
| `project` | `.claude/skills/` relative to CWD | Highest |
| `user` | `~/.claude/skills/` | Middle |
| `bundled` | Package-bundled skills | Lowest |

When two tiers define a skill with the same name, the higher-priority tier wins. The lower-tier skill is **shadowed** and a warning is emitted via `onShadowedSkill`.

### Security Model (fail-closed)

Loading a skill at `body` level runs `@koi/skill-scanner` on all embedded code blocks and the full markdown text.

- Findings at or above `blockOnSeverity` (default: `"HIGH"`) → `{ ok: false, error: { code: "PERMISSION", ... } }`
- Findings below `blockOnSeverity` → warning emitted via `onSecurityFinding`, skill loads normally

This is **fail-closed**: a skill with `eval()` in a code block does not load unless you explicitly lower the threshold.

## Public API

```typescript
import { createSkillsRuntime } from "@koi/skills-runtime";
import type { SkillsRuntime, SkillDefinition, SkillsRuntimeConfig } from "@koi/skills-runtime";
```

### `createSkillsRuntime(config?: SkillsRuntimeConfig): SkillsRuntime`

Factory. Creates an instance-scoped runtime. The scanner, cache, and resolved base paths all live inside this instance — no global state.

### `SkillsRuntimeConfig`

```typescript
interface SkillsRuntimeConfig {
  /** Path to project-local skills dir. Default: .claude/skills relative to CWD. */
  readonly projectRoot?: string;
  /** Path to user-level skills dir. Default: ~/.claude/skills. */
  readonly userRoot?: string;
  /** Path to bundled skills dir. Default: package-internal bundled/. */
  readonly bundledRoot?: string;
  /** Severity threshold for blocking skill loads. Default: "HIGH". */
  readonly blockOnSeverity?: Severity;
  /** Called when a lower-tier skill is shadowed by a higher-tier skill. */
  readonly onShadowedSkill?: (name: string, shadowedBy: SkillSource) => void;
  /** Called when a skill passes security scan but has findings below the block threshold. */
  readonly onSecurityFinding?: (name: string, findings: readonly ScanFinding[]) => void;
}
```

### `SkillsRuntime`

```typescript
interface SkillsRuntime {
  readonly discover: () => Promise<Result<ReadonlyMap<string, SkillMetadata>, KoiError>>;
  readonly load: (name: string) => Promise<Result<SkillDefinition, KoiError>>;
  readonly loadAll: () => Promise<Result<ReadonlyMap<string, Result<SkillDefinition, KoiError>>, KoiError>>;
  readonly query: (filter?: SkillQuery) => Promise<Result<readonly SkillMetadata[], KoiError>>;
  readonly invalidate: (name?: string) => void;
  readonly registerExternal: (skills: readonly SkillMetadata[]) => void;
}
```

### `registerExternal(skills)`

Injects non-filesystem skills (e.g., MCP-derived) into the runtime. External skills have lowest precedence — any filesystem skill with the same name shadows them. Replaces all previously registered external skills (full replacement, not merge). Cache for filesystem skills is not affected.

### `SkillMetadata`

Frontmatter-only — available after `discover()` without loading the body.

```typescript
interface SkillMetadata {
  readonly name: string;
  readonly description: string;
  readonly source: SkillSource;
  readonly dirPath: string;
  readonly tags?: readonly string[];
  readonly license?: string;
  readonly compatibility?: string;
  readonly allowedTools?: readonly string[];
  readonly requires?: ValidatedSkillRequires;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly executionMode?: "inline" | "fork";
}
```

### `SkillDefinition`

Extends `SkillMetadata` with the full body. Available after `load()`.

```typescript
interface SkillDefinition extends SkillMetadata {
  readonly body: string;
}
```

### `SkillQuery`

```typescript
interface SkillQuery {
  readonly source?: SkillSource;
  readonly tags?: readonly string[];    // AND semantics: skill must have ALL tags
  readonly capability?: string;          // matches against allowedTools
}
```

### `SkillSource`

```typescript
type SkillSource = "bundled" | "user" | "project" | "mcp";
```

## Usage Example

```typescript
import { createSkillsRuntime } from "@koi/skills-runtime";

const runtime = createSkillsRuntime({
  blockOnSeverity: "HIGH",
  onShadowedSkill: (name, by) =>
    console.warn(`Skill "${name}" shadowed by ${by} source`),
  onSecurityFinding: (name, findings) =>
    console.warn(`Skill "${name}" has ${findings.length} low-severity findings`),
});

// Discover all available skills — returns SkillMetadata (frontmatter only, no body)
const discovered = await runtime.discover();
if (!discovered.ok) throw new Error(discovered.error.message);

// Query skills by tags (AND semantics) — metadata only, no body loaded
const tsSkills = await runtime.query({ tags: ["typescript"], source: "project" });
if (tsSkills.ok) {
  for (const meta of tsSkills.value) {
    console.log(`${meta.name}: ${meta.description} [tags: ${meta.tags?.join(", ")}]`);
  }
}

// Load a specific skill (parse + validate + security scan → full body)
const result = await runtime.load("code-review");
if (!result.ok) {
  // result.error.code === "NOT_FOUND" | "VALIDATION" | "PERMISSION" (blocked by scan)
  console.error(result.error.message);
} else {
  console.log(result.value.body);
}

// Load everything at once (parallel, partial success)
const allResult = await runtime.loadAll();
if (allResult.ok) {
  for (const [name, result] of allResult.value) {
    if (!result.ok) console.warn(`Skipped ${name}: ${result.error.message}`);
  }
}

// Invalidate after a skill file changes on disk
runtime.invalidate("code-review");  // clears body cache only, metadata preserved
runtime.invalidate();                // full reset — re-discovers on next call
```

## File Layout Convention

Each skill is a directory containing a `SKILL.md` file:

```
.claude/skills/
  code-review/
    SKILL.md        ← required: YAML frontmatter + markdown body
    scripts/        ← optional: helper scripts (max 50 files, 512 KB each)
    references/     ← optional: reference documents
    assets/         ← optional: output templates
```

## SKILL.md Format

```markdown
---
name: code-review
description: Reviews code for quality, security, and best practices.
license: MIT
tags:
  - quality
  - security
allowed-tools: read_file write_file
execution: inline
requires:
  bins: [git]
  env: [GITHUB_TOKEN]
---

# Code Review Skill

Follow these steps...
```

The `execution` field is optional (defaults to `inline`). Set to `fork` for skills that should run as isolated sub-agents.

## Execution Modes

Skills support two execution modes, declared in SKILL.md frontmatter:

| Mode | Behavior | Default |
|------|----------|---------|
| `inline` | Skill body injected as context into the current agent | Yes |
| `fork` | Skill delegates to a sub-agent via `SpawnRequest` | No |

```yaml
---
name: deep-analysis
description: Performs deep code analysis.
execution: fork
allowed-tools: read_file grep
---
```

**Inline mode** (default) is what skills have always done — the body becomes context for the model.

**Fork mode** maps the skill to a `SpawnRequest`:
- `systemPrompt` ← skill body
- `toolAllowlist` ← skill `allowedTools`
- `description` ← skill name

The caller can override execution mode at runtime regardless of what the manifest declares.

## MCP-Derived Skills

When `@koi/mcp` is present, MCP tool descriptors can be registered as skills via `registerExternal()`. This gives them first-class visibility in the skill registry without pretending they are filesystem-based SKILL.md files.

### Source Precedence (updated)

With MCP, the precedence order becomes:

| Tier | Default path | Priority |
|------|-------------|----------|
| `project` | `.claude/skills/` relative to CWD | Highest |
| `user` | `~/.claude/skills/` | Middle |
| `bundled` | Package-bundled skills | Low |
| `mcp` | Registered via `registerExternal()` | Lowest |

Filesystem skills always shadow MCP-derived skills of the same name.

### Registration

```typescript
import { createSkillsRuntime } from "@koi/skills-runtime";
import type { SkillMetadata } from "@koi/skills-runtime";

const runtime = createSkillsRuntime();

// Bridge package maps MCP ToolDescriptors → SkillMetadata
const mcpSkills: readonly SkillMetadata[] = [
  {
    name: "mcp__my-server__search",
    description: "Search documents via MCP server",
    source: "mcp",
    dirPath: "mcp://my-server",
  },
];

runtime.registerExternal(mcpSkills);

// MCP skills now appear in discover() and query()
const result = await runtime.query({ source: "mcp" });
```

### Cache Separation

External (MCP) skills and filesystem skills use **separate internal caches**. When an MCP server reconnects and updates its tool list, calling `registerExternal()` replaces external entries without triggering a filesystem re-scan. `invalidate()` clears both caches. `invalidate(name)` checks both.

### Bridge Package Pattern (Layer Safety)

`@koi/skills-runtime` (L2) cannot import from `@koi/mcp` (L2 peer) — this would violate the layer rules. Instead:

1. `@koi/skills-runtime` defines `registerExternal(skills)` accepting `SkillMetadata[]`
2. A thin bridge package (or L3 `@koi/runtime`) imports both and wires the mapping
3. The bridge listens to `McpResolver.onChange()` and calls `registerExternal()` with updated skills

## Skill Injection Middleware

`createSkillInjectorMiddleware` reads `SkillComponent` entries from the agent ECS and prepends their content into `request.systemPrompt` so the model follows skill guidance.

```typescript
import { createSkillInjectorMiddleware } from "@koi/skills-runtime";
import type { Agent } from "@koi/core";

// Lazy agent ref — middleware created before createKoi assembles the entity
const agentRef: { current?: Agent } = {};
const injector = createSkillInjectorMiddleware({
  agent: () => {
    if (agentRef.current === undefined) throw new Error("Agent not yet wired");
    return agentRef.current;
  },
});

// Pass to createKoi alongside the skill provider
const runtime = await createKoi({
  middleware: [injector],
  providers: [createSkillProvider(skillRuntime)],
});
agentRef.current = runtime.agent;
```

**Design:**
- Phase: `"resolve"`, priority 300 — after permissions, before observability
- Skills sorted alphabetically by name for deterministic `systemPrompt` text
- Accepts `Agent | (() => Agent)` — direct reference or lazy thunk
- `describeCapabilities` returns a fragment listing active skill count and names
- Passthrough (no copy) when no skills are attached
- Empty-body skills (e.g., MCP-derived metadata-only entries) are filtered out of `collectSkillContent()` — they contribute to capability discovery but do not inject blank content into the system prompt

## ComponentProvider Bridge

`createSkillProvider` bridges a `SkillsRuntime` to the agent ECS at assembly time:

```typescript
import { createSkillProvider, createSkillsRuntime } from "@koi/skills-runtime";

const runtime = createSkillsRuntime();
const provider = createSkillProvider(runtime);
// Pass to createKoi({ providers: [provider] })
```

Each loaded skill becomes a `SkillComponent` under `skillToken(name)`. Skipped skills (NOT_FOUND, VALIDATION, PERMISSION) are reported as `SkippedComponent` entries.

## ATIF Trace Integration

When wrapped by `wrapMiddlewareWithTrace` (L3 runtime), the skill-injector
emits structured decision metadata via `ctx.reportDecision` only when skills
are actually injected into the model request (passthrough is silent).

Captured fields:
```typescript
{
  injected: boolean;        // Always true when reported
  skillCount: number;
  skills: Array<{ name: string; contentLength: number }>;
  systemPrompt: string;     // Preview of the final injected systemPrompt (≤800 chars)
}
```

The decision appears in the ATIF trajectory as `metadata.decisions[]` on the
`middleware:skill-injector` span. Consumers (e.g., `/trajectory` in the TUI)
can see exactly which skills were injected and a preview of the resulting
system prompt. The passthrough guard uses reference equality
(`injected !== request`) on the `ModelRequest` object, which avoids a second
`sortedSkills()` call per hook invocation.

## Dependencies

- `@koi/core` (L0) — `KoiError`, `Result`, `Agent`, `SkillComponent`, `KoiMiddleware`
- `@koi/skill-scanner` (L0u) — AST-based security scanning
- `@koi/validation` (L0u) — severity comparison, Zod error mapping
- `zod` (external) — frontmatter schema validation
