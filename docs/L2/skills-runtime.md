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
}
```

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
type SkillSource = "bundled" | "user" | "project";
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
requires:
  bins: [git]
  env: [GITHUB_TOKEN]
---

# Code Review Skill

Follow these steps...
```

## Dependencies

- `@koi/core` (L0) — `KoiError`, `Result`
- `@koi/skill-scanner` (L0u) — AST-based security scanning
- `@koi/validation` (L0u) — severity comparison, Zod error mapping
- `zod` (external) — frontmatter schema validation
