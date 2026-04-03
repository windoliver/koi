# @koi/skills — Progressive Skill Loading

`@koi/skills` is an L2 package that provides 3-level progressive loading (metadata, body, bundled) for both filesystem skills (SKILL.md) and forged skills (ForgeStore artifacts). Skills start cheap and upgrade on demand when the agent actually needs them.

---

## Why It Exists

An agent with 20 skills that loads every skill's full instructions on turn 1 wastes context window tokens on skills the user never references. With 2-8 KB per skill body, that's 40-160 KB of wasted context.

Progressive loading solves this:

```
BEFORE: All skills fully loaded on every turn
┌──────────────────────────────────────────────────┐
│ skill:code-review    (4 KB)                      │
│ skill:testing        (6 KB)                      │
│ skill:deploy         (8 KB)      Total: 23 KB    │
│ skill:security-audit (5 KB)      in context      │
└──────────────────────────────────────────────────┘
  User only needs "code-review" → 19 KB wasted

AFTER: Only descriptions loaded, full content on demand
┌──────────────────────────────────────────────────┐
│ code-review:    "Reviews code for quality…" (100B)│
│ testing:        "Runs test suites…"         (80B)│
│ deploy:         "Deploys to production…"    (90B)│  Total: ~400 B
│ security-audit: "Scans for vulnerabilities" (80B)│
└──────────────────────────────────────────────────┘
  User says "skill:code-review" → only that loads to 4 KB
```

Without this package, every agent builder would reimplement skill parsing, security scanning, and context-aware loading.

This applies equally to **predefined skills** (SKILL.md on disk) and **forged skills** (SkillArtifact in ForgeStore, created by agents at runtime). Both sources share the same progressive loading strategy — no second-class citizens.

---

## Architecture

### Layer position

```
L0  @koi/core              ─ SkillConfig, SkillSource, ForgeStore, BrickId,
                              SkillComponent, ComponentProvider, ComponentEvent,
                              skillToken(), fsSkill(), forgedSkill() (types + pure helpers)
L0u @koi/skill-scanner      ─ security scan for embedded code
L0u @koi/validation         ─ frontmatter schema validation (Zod)
L2  @koi/skills             ─ this package (no L1 dependency)
```

`@koi/skills` only imports from `@koi/core` (L0) and L0u packages. It never touches `@koi/engine` (L1). ForgeStore is an L0 interface, so importing it is legal. Skills can be loaded in any environment — CLI, test harness, CI.

### Internal module map

```
index.ts                         ← public re-exports
│
├── parse.ts                     ← parseSkillMd() — YAML frontmatter + markdown
├── validate.ts                  ← validateSkillFrontmatter() — schema checks
├── loader.ts                    ← loadSkill{Metadata,Body,Bundled}() + cache (filesystem)
├── loader-forge.ts              ← loadForgeSkill{Metadata,Body,Bundled}() + cache (ForgeStore)
├── provider.ts                  ← createSkillComponentProvider() factory (dual-source)
├── skill-activator-middleware.ts ← auto-promote middleware
├── catalog.ts                   ← skill catalog integration
├── types.ts                     ← ProgressiveSkillProvider, SkillLoadLevel
│
└── fixtures/                    ← test SKILL.md files
    ├── valid-skill/SKILL.md
    └── minimal-skill/SKILL.md
```

---

## How It Works

### The Three Load Levels

Every skill can exist at one of three levels. Each level includes everything from the level below it:

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ metadata │────►│   body   │────►│ bundled  │
│  ~100 B  │     │  ~2-8 KB │     │ ~5-20 KB │
│          │     │          │     │          │
│ name     │     │ name     │     │ name     │
│ desc     │     │ desc     │     │ desc     │
│ tags     │     │ tags     │     │ tags     │
│          │     │ markdown │     │ markdown │
│          │     │ body     │     │ body     │
│          │     │          │     │ scripts  │
│          │     │          │     │ refs     │
│          │     │          │     │ assets   │
└──────────┘     └──────────┘     └──────────┘
   promote()        promote()
```

| Level | Content | Context cost | Use case |
|-------|---------|-------------|----------|
| **metadata** | name + description + tags | ~100 bytes | Skill catalog, discovery |
| **body** | metadata + full markdown instructions | ~2-8 KB | Active skill usage |
| **bundled** | body + scripts + references + assets | ~5-20 KB | Skills needing embedded code or templates |

### Unified Skill Source

Skills are declared using a discriminated `SkillSource` type in L0:

```typescript
import { fsSkill, forgedSkill, brickId } from "@koi/core";

// Filesystem skill — loaded from SKILL.md on disk
fsSkill("code-review", "./skills/code-review")
// → { name: "code-review", source: { kind: "filesystem", path: "./skills/code-review" } }

// Forged skill — loaded from ForgeStore by content-addressed BrickId
forgedSkill("custom-review", brickId("sha256:abc123"))
// → { name: "custom-review", source: { kind: "forged", brickId: "sha256:abc123" } }
```

The provider dispatches to the correct loader based on `source.kind`. Both sources go through the same progressive loading pipeline.

### Progressive Loading Flow

```
createSkillComponentProvider()
    │
    ▼
  attach(agent)
    │
    ├── resolve paths / validate sources (sequential, cheap)
    ├── dispatch by source.kind:
    │     filesystem → resolveSecurePath + loadSkill()
    │     forged     → loadForgeSkill() via ForgeStore
    ├── Promise.allSettled (parallel load at "metadata")
    ├── build SkillComponent for each skill
    └── return { components, skipped }
    │
    ▼
  Agent starts with minimal context
    │
    ▼
  User says "use skill:code-review"
    │
    ├── skill-activator middleware detects "skill:code-review"
    └── fire-and-forget: provider.promote("code-review", "body")
        │
        ├── dispatch by source.kind:
        │     filesystem → load SKILL.md body from disk
        │     forged     → parse artifact.content from cache
        ├── update component in internal map
        ├── fire ComponentEvent { kind: "attached" }
        └── getLevel("code-review") returns "body"
```

### Skill Activator Middleware

The `createSkillActivatorMiddleware` hooks into `wrapModelCall` to scan user messages for `skill:<name>` references and auto-promote matching skills:

```
User message: "Use skill:code-review to check my PR"
                          │
              ┌───────────▼────────────────┐
              │  skill-activator (pri=200)  │
              │                            │
              │  regex: /\bskill:([a-z-]+)/│
              │  match: "code-review"      │
              │                            │
              │  provider.getLevel()       │
              │  → "metadata" (known)      │
              │                            │
              │  void promote("code-review",│
              │               "body")       │
              │  (fire-and-forget)          │
              └────────────────────────────┘
                          │
                          ▼
                    next(request)
                    (model call proceeds immediately)
```

Priority 200 ensures it runs before tool-selector (300) and crystallize (950).

### Manifest YAML Format

Skills are declared in the agent manifest with a `source` discriminant:

```yaml
skills:
  # Filesystem skill — loaded from SKILL.md in the given directory
  - name: code-review
    source:
      kind: filesystem
      path: ./skills/code-review

  # Forged skill — loaded from ForgeStore by content-addressed BrickId
  - name: custom-review
    source:
      kind: forged
      brickId: "sha256:abc123"
```

### SKILL.md File Format

```markdown
---
name: code-review
description: Reviews code for quality, security, and best practices.
allowedTools:
  - read_file
  - write_file
  - search
---

# Code Review Skill

## Instructions

When asked to review code:
1. Read the file with read_file
2. Check for common issues
3. Write suggestions

```javascript
// scripts/helper.sh is available at bundled level
function reviewCode(file) { /* ... */ }
```​
```

---

## API Reference

### `createSkillComponentProvider(config)`

Factory function that returns a `ProgressiveSkillProvider`.

```typescript
import { createSkillComponentProvider } from "@koi/skills";
import { fsSkill } from "@koi/core";

const provider = createSkillComponentProvider({
  skills: [
    fsSkill("code-review", "./skills/code-review"),
    fsSkill("testing", "./skills/testing"),
  ],
  basePath: "/path/to/project",
  loadLevel: "body",  // default target for promote()
  onSecurityFinding: (name, findings) => {
    console.warn(`Security findings in ${name}:`, findings);
  },
});
```

**Config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `skills` | `readonly SkillConfig[]` | required | Skill entries from manifest |
| `basePath` | `string` | required | Base path for resolving relative skill paths |
| `loadLevel` | `SkillLoadLevel` | `"body"` | Default target level for `promote()` |
| `onSecurityFinding` | `(name, findings) => void` | `undefined` | Callback for security scanner findings |
| `store` | `ForgeStore` | `undefined` | ForgeStore instance — **required** if any skill has `source.kind === "forged"` |

**Fail-fast:** If any skill has `source.kind === "forged"` but no `store` is provided, `createSkillComponentProvider` throws immediately at creation time.

**Returns:** `ProgressiveSkillProvider`

| Method | Signature | Description |
|--------|-----------|-------------|
| `attach` | `(agent: Agent) => Promise<AttachResult>` | Load all skills at metadata level |
| `promote` | `(name: string, level?: SkillLoadLevel) => Promise<Result<void, KoiError>>` | Upgrade a skill to a higher level |
| `getLevel` | `(name: string) => SkillLoadLevel \| undefined` | Query current level of a skill |
| `watch` | `(listener: (event: ComponentEvent) => void) => () => void` | Subscribe to promotion events |

### `createSkillActivatorMiddleware(config)`

Factory function that returns a `KoiMiddleware` for auto-promoting skills.

```typescript
import { createSkillActivatorMiddleware } from "@koi/skills";

const activator = createSkillActivatorMiddleware({
  provider: skillProvider,
  targetLevel: "body",  // default
});

const runtime = await createKoi({
  manifest,
  adapter,
  middleware: [activator],
  providers: [skillProvider],
});
```

**Config:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `ProgressiveSkillProvider` | required | The skill provider to promote on |
| `targetLevel` | `SkillLoadLevel` | `"body"` | Level to promote to when a skill is referenced |

### `parseSkillMd(content)`

Parses a SKILL.md string into structured frontmatter + body.

### `validateSkillFrontmatter(frontmatter)`

Validates parsed frontmatter against the Agent Skills Standard schema.

### `loadSkill(dirPath, level, onSecurityFinding?)`

Loads a skill from a directory at a specific level. Uses an internal cache to avoid re-parsing frontmatter when promoting.

### `clearSkillCache()`

Clears the internal filesystem frontmatter cache. Useful in tests.

### `loadForgeSkill(brickId, store, level?, onSecurityFinding?)`

Loads a forged skill from ForgeStore at a specific level. Caches the full artifact on first load, then exposes progressively. Dispatcher for the three level-specific loaders below.

### `loadForgeSkillMetadata(brickId, store)`

Trusts artifact fields directly (name, description, tags). No content parsing — cheapest level.

### `loadForgeSkillBody(brickId, store, onSecurityFinding?)`

Parses `artifact.content` via `parseSkillMd()` + validates frontmatter. Always runs security scanner on forged content (defense-in-depth).

### `loadForgeSkillBundled(brickId, store, onSecurityFinding?)`

Body-level + maps `artifact.files` to scripts/references. Convention: file keys starting with `scripts/` become SkillScript, `references/` become SkillReference.

### `clearForgeSkillCache()`

Clears the internal forge artifact cache. Useful in tests.

---

## Integration with createKoi

### Filesystem-only (predefined skills)

```typescript
import { createKoi } from "@koi/engine";
import { createLoopAdapter } from "@koi/engine-loop";
import { createSkillComponentProvider, createSkillActivatorMiddleware } from "@koi/skills";

const provider = createSkillComponentProvider({
  skills: manifest.skills ?? [],
  basePath: "./",
});

const activator = createSkillActivatorMiddleware({ provider });

const runtime = await createKoi({
  manifest: {
    name: "my-agent",
    version: "1.0.0",
    model: { name: "claude-haiku-4-5" },
  },
  adapter: createLoopAdapter({ modelCall }),
  middleware: [activator],
  providers: [provider],
});

// Skills start at metadata. When user says "skill:code-review",
// the activator auto-promotes it to body level.
const events = await collectEvents(
  runtime.run({ kind: "text", text: "Use skill:code-review to check main.ts" })
);
```

### Mixed sources (filesystem + forged)

```typescript
import { fsSkill, forgedSkill, brickId } from "@koi/core";
import { createSkillComponentProvider, createSkillActivatorMiddleware } from "@koi/skills";

const provider = createSkillComponentProvider({
  skills: [
    // Predefined skill from disk
    fsSkill("code-review", "./skills/code-review"),
    // Agent-forged skill from ForgeStore
    forgedSkill("custom-review", brickId("sha256:abc123")),
  ],
  basePath: "./",
  store: myForgeStore,  // required when forged skills exist
});

// Both skill types use the same progressive loading:
// - Start at ~100 bytes (metadata only)
// - Auto-promote to body on reference
// - Same security scanning, caching, and deduplication
```

---

## Design Decisions

1. **Always start at metadata** — `loadLevel` config is the promote target, not the initial level. This ensures minimal context usage from turn 0.
2. **Fire-and-forget promotion** — `promote()` runs concurrently with the model call. The model sees the skill description immediately; full instructions arrive for the next turn.
3. **Frontmatter cache** — parsed SKILL.md frontmatter is cached per directory path. Promoting from metadata to body reuses the cached parse, avoiding redundant filesystem reads.
4. **Parallel loading** — `Promise.allSettled` loads all skills concurrently during `attach()`. Failed skills go to `skipped`, successful ones proceed.
5. **First-wins deduplication** — duplicate skill names are resolved by declaration order. The first definition wins; duplicates are reported in `skipped`.
6. **No L1 dependency** — the provider works anywhere. Only the middleware needs the L1 runtime to intercept model calls.
7. **Discriminated SkillSource** — `source.kind` ("filesystem" | "forged") enables exhaustive switch dispatch with zero runtime overhead. Factory helpers `fsSkill()` / `forgedSkill()` live in L0 as pure data constructors.
8. **Separate caches per source** — filesystem cache is keyed by directory path, forge cache is keyed by BrickId. No cross-contamination, independent invalidation.
9. **Hybrid metadata** — at metadata level, forged skills trust artifact fields directly (no content parsing). Content is only parsed at body level. This avoids redundant work since ForgeStore artifacts already carry validated name/description/tags.
10. **Defense-in-depth on forge** — security scanner always runs on forged skill content at body level, even though artifacts were presumably scanned during creation. Trust but verify.
11. **Fail-fast on missing store** — if a manifest declares forged skills but no ForgeStore is provided, `createSkillComponentProvider` throws immediately rather than failing silently at attach time.
12. **Error isolation** — a forged skill failing to load does not block filesystem skills (and vice versa). Failures are reported in `skipped`.

---

## Bundled Directory Conventions

At the **bundled** load level, three sibling directories are scanned alongside `SKILL.md`:

```
skills/code-review/
├── SKILL.md           ← frontmatter + markdown body
├── scripts/           ← executable helper scripts
│   └── lint.sh
├── references/        ← input knowledge the agent reads
│   └── conventions.md
└── assets/            ← output templates the agent fills in
    └── report-template.md
```

| Directory | Purpose | When to use |
|-----------|---------|-------------|
| `scripts/` | Helper scripts the agent can execute | Shell automation, code generation |
| `references/` | Input knowledge — conventions, checklists, style guides | Agent reads these to inform its work |
| `assets/` | Output templates — scaffolds, report layouts, plan structures | Agent populates these to produce structured output |

The distinction between `references/` and `assets/` is directional: references flow **in** (agent reads them), assets flow **out** (agent fills them in). Both are loaded as `{ filename, content }` pairs.

For **forged skills**, the same convention applies to `artifact.files` keys: `scripts/lint.sh`, `references/conventions.md`, `assets/report-template.md`.

---

## Content Design Patterns

The preceding sections cover how to **load and wire** skills. This section covers how to **write the markdown body** — the content the agent actually sees.

Seven recurring patterns emerge across skills in the Koi ecosystem. Each pattern answers a different design question. Use `metadata.pattern` in frontmatter to classify your skill.

### Choosing a pattern

```
Does the skill teach when/how to use a tool or library?
  └─ YES → Tool Wrapper

Does the skill produce structured output from a template?
  └─ YES → Generator

Does the skill evaluate work against criteria?
  └─ YES → Reviewer

Does the skill need to gather requirements before acting?
  └─ YES → Inversion

Does the skill enforce a multi-step process with checkpoints?
  └─ YES → Pipeline

Is the skill bundled with a BrickDescriptor (engine/channel adapter)?
  └─ YES → Companion

Does the skill wrap token-budgeted retrieval from a knowledge base?
  └─ YES → Guide
```

### Pattern 1: Tool Wrapper

Gives the agent on-demand context for a specific library or tool. The SKILL.md loads reference docs from `references/` and applies them as instructions.

**When to use:** The agent needs domain expertise about a framework, API, or internal convention.

**Structure:**

```markdown
---
name: fastapi-expert
description: FastAPI conventions and best practices
metadata:
  pattern: tool-wrapper
  domain: fastapi
---

You are an expert in FastAPI development.

## When reviewing code
1. Load 'references/conventions.md' for the complete list
2. Check the user's code against each convention
3. For each violation, cite the specific rule and suggest the fix

## When writing code
1. Follow every convention in references/conventions.md exactly
2. Add type annotations to all function signatures
```

**Koi-specific:** Provider skills (see `docs/architecture/provider-skills.md`) are tool wrappers shipped alongside tool providers. They follow the 4-section template: Overview, When to use, Workflow, Error handling. Twelve packages already ship provider skills — use this as your baseline.

**Key files:**
- `references/` — conventions, API docs, style guides

### Pattern 2: Generator

Produces consistent structured output by filling in a template. The agent loads a template from `assets/`, a style guide from `references/`, gathers variables from the user, and populates the document.

**When to use:** You need deterministic output structure across runs — reports, documentation, scaffolds, commit messages.

**Structure:**

```markdown
---
name: report-generator
description: Generates structured technical reports
metadata:
  pattern: generator
  output-format: markdown
---

Follow these steps exactly:

Step 1: Load 'references/style-guide.md' for tone and formatting rules.
Step 2: Load 'assets/report-template.md' for the required output structure.
Step 3: Ask the user for any missing information:
  - Topic or subject
  - Key findings or data points
  - Target audience
Step 4: Fill the template following the style guide. Every section must be present.
Step 5: Return the completed report as a single document.
```

**Key files:**
- `references/` — style guide, formatting rules
- `assets/` — output template the agent fills in

### Pattern 3: Reviewer

Separates **what to check** from **how to check it**. The agent loads a rubric from `references/` and methodically scores the submission, grouping findings by severity.

**When to use:** PR reviews, security audits, accessibility checks, compliance verification.

**Structure:**

```markdown
---
name: code-reviewer
description: Reviews code for quality and common issues
metadata:
  pattern: reviewer
  severity-levels: error,warning,info
---

Follow this review protocol:

Step 1: Load 'references/review-checklist.md' for the review criteria.
Step 2: Read the user's code. Understand its purpose before critiquing.
Step 3: For each checklist rule, check the code. For violations:
  - Note the location
  - Classify: error (must fix), warning (should fix), info (consider)
  - Explain WHY, not just WHAT
  - Suggest a fix with corrected code
Step 4: Produce a structured review:
  - **Summary**: What the code does, overall quality
  - **Findings**: Grouped by severity (errors first)
  - **Score**: 1-10 with justification
```

**Key files:**
- `references/review-checklist.md` — modular rubric (swap it for OWASP to get a security audit)

### Pattern 4: Inversion

Flips the agent/user dynamic. Instead of the agent guessing and generating, it **interviews the user** through structured questions before producing output. Explicit gating instructions prevent the agent from acting prematurely.

**When to use:** Requirements gathering, project planning, configuration wizards — any task where incomplete context leads to wasted work.

**Structure:**

```markdown
---
name: project-planner
description: Plans projects by gathering requirements first
metadata:
  pattern: inversion
  interaction: multi-turn
---

You are conducting a structured requirements interview.
DO NOT start building until all phases are complete.

## Phase 1 — Problem Discovery (ask one at a time, wait for each)
- Q1: "What problem does this solve for its users?"
- Q2: "Who are the primary users?"
- Q3: "What is the expected scale?"

## Phase 2 — Technical Constraints (only after Phase 1)
- Q4: "What deployment environment?"
- Q5: "Any stack requirements?"
- Q6: "Non-negotiable requirements?"

## Phase 3 — Synthesis (only after all questions answered)
1. Load 'assets/plan-template.md'
2. Fill in every section using gathered requirements
3. Ask: "Does this capture your requirements?"
4. Iterate until confirmed
```

**Gating convention:** Use explicit "DO NOT proceed to Phase N until..." instructions. The agent must respect these as hard checkpoints.

### Pattern 5: Pipeline

Enforces a strict sequential workflow with hard checkpoints. Each step must complete (and sometimes receive user approval) before the next begins. Uses all directory types at the specific step where they're needed.

**When to use:** Multi-step workflows where skipping a step produces invalid output — doc generation, deployment, migration.

**Structure:**

```markdown
---
name: doc-pipeline
description: Generates API docs from source through a multi-step pipeline
metadata:
  pattern: pipeline
  steps: "4"
---

Execute each step in order. Do NOT skip steps.

## Step 1 — Parse & Inventory
Analyze the code. Present the public API as a checklist.
Ask: "Is this the complete API you want documented?"

## Step 2 — Generate Docstrings
Load 'references/docstring-style.md' for the format.
Present each generated docstring for user approval.
DO NOT proceed to Step 3 until the user confirms.

## Step 3 — Assemble Documentation
Load 'assets/api-doc-template.md' for the structure.
Compile all symbols into a single reference document.

## Step 4 — Quality Check
Review against 'references/quality-checklist.md'.
Fix issues before presenting the final document.
```

**Key files:**
- `references/` — style guides and checklists loaded at specific steps
- `assets/` — output template loaded only at assembly step

### Pattern 6: Companion

Teaching prompts bundled with `BrickDescriptor` packages. These are not standalone SKILL.md files — they're inline `companionSkills` on descriptors, auto-registered to ForgeStore during agent startup.

**When to use:** An L2 package (engine adapter, channel adapter) needs to teach the LLM when to use it.

See `docs/architecture/companion-skills.md` for details.

### Pattern 7: Guide

Token-budgeted retrieval from a knowledge base. The agent uses the `ask_guide` tool to search a corpus, receiving only concise, relevant chunks instead of raw search dumps.

**When to use:** Agents with access to large skill/doc libraries where unbounded search would flood the context window.

See `docs/patterns/guide-agent.md` for details.

### Composing patterns

Patterns are not mutually exclusive:

- A **Pipeline** can include a **Reviewer** step to verify its own output
- A **Generator** can start with an **Inversion** phase to gather template variables
- A **Tool Wrapper** can embed a **Reviewer** checklist for its domain

The `includes` frontmatter directive and progressive loading ensure the agent only spends context tokens on the patterns it needs at runtime.
