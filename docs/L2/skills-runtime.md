# @koi/skills-runtime

**Layer:** L2  
**Location:** `packages/lib/skills-runtime`  
**Purpose:** Multi-source skill discovery and loading for Koi agents.

Discovers SKILL.md files from three source tiers (bundled, user, project), enforces project-wins precedence, security-scans each skill's code blocks, and loads skills into a flat `Map<string, SkillDefinition>` ready for agent assembly.

## Architecture

```
createSkillsRuntime(config)
  ├── discover()      ← walks bundled/user/project roots, project > user > bundled
  ├── load(name)      ← parse + validate + security scan + cache
  └── loadAll()       ← load all discovered skills in parallel
```

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
  readonly discover: () => Promise<Result<Map<string, SkillSource>, KoiError>>;
  readonly load: (name: string) => Promise<Result<SkillDefinition, KoiError>>;
  readonly loadAll: () => Promise<Map<string, Result<SkillDefinition, KoiError>>>;
}
```

### `SkillDefinition`

```typescript
interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly source: SkillSource;
  readonly dirPath: string;
  readonly license?: string;
  readonly compatibility?: string;
  readonly allowedTools?: readonly string[];
  readonly requires?: ValidatedSkillRequires;
  readonly metadata?: Readonly<Record<string, string>>;
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

// Discover all available skill names across all three sources
const discovered = await runtime.discover();
if (!discovered.ok) throw new Error(discovered.error.message);

// Load a specific skill (parse + validate + security scan)
const result = await runtime.load("code-review");
if (!result.ok) {
  // result.error.code === "NOT_FOUND" | "VALIDATION" | "PERMISSION" (blocked by scan)
  console.error(result.error.message);
} else {
  console.log(result.value.body);
}

// Load everything at once (parallel, partial success)
const all = await runtime.loadAll();
for (const [name, result] of all) {
  if (!result.ok) console.warn(`Skipped ${name}: ${result.error.message}`);
}
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
