# @koi/skills — Progressive Skill Loading

`@koi/skills` is an L2 package that parses SKILL.md files and provides 3-level progressive loading (metadata, body, bundled) to minimize context window usage. Skills start cheap and upgrade on demand when the agent actually needs them.

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

---

## Architecture

### Layer position

```
L0  @koi/core              ─ SkillComponent, SkillConfig, ComponentProvider,
                              ComponentEvent, skillToken() (types only)
L0u @koi/skill-scanner      ─ security scan for embedded code
L0u @koi/validation         ─ frontmatter schema validation (Zod)
L2  @koi/skills             ─ this package (no L1 dependency)
```

`@koi/skills` only imports from `@koi/core` (L0) and L0u packages. It never touches `@koi/engine` (L1). Skills can be loaded in any environment — CLI, test harness, CI.

### Internal module map

```
index.ts                         ← public re-exports
│
├── parse.ts                     ← parseSkillMd() — YAML frontmatter + markdown
├── validate.ts                  ← validateSkillFrontmatter() — schema checks
├── loader.ts                    ← loadSkill{Metadata,Body,Bundled}() + cache
├── provider.ts                  ← createSkillComponentProvider() factory
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
└──────────┘     └──────────┘     └──────────┘
   promote()        promote()
```

| Level | Content | Context cost | Use case |
|-------|---------|-------------|----------|
| **metadata** | name + description + tags | ~100 bytes | Skill catalog, discovery |
| **body** | metadata + full markdown instructions | ~2-8 KB | Active skill usage |
| **bundled** | body + embedded scripts + reference files | ~5-20 KB | Skills that need code execution |

### Progressive Loading Flow

```
createSkillComponentProvider()
    │
    ▼
  attach(agent)
    │
    ├── resolve paths (sequential, cheap)
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
        ├── load full SKILL.md body from filesystem
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

const provider = createSkillComponentProvider({
  skills: [
    { name: "code-review", path: "./skills/code-review" },
    { name: "testing", path: "./skills/testing" },
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

Clears the internal frontmatter cache. Useful in tests.

---

## Integration with createKoi

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

---

## Design Decisions

1. **Always start at metadata** — `loadLevel` config is the promote target, not the initial level. This ensures minimal context usage from turn 0.
2. **Fire-and-forget promotion** — `promote()` runs concurrently with the model call. The model sees the skill description immediately; full instructions arrive for the next turn.
3. **Frontmatter cache** — parsed SKILL.md frontmatter is cached per directory path. Promoting from metadata to body reuses the cached parse, avoiding redundant filesystem reads.
4. **Parallel loading** — `Promise.allSettled` loads all skills concurrently during `attach()`. Failed skills go to `skipped`, successful ones proceed.
5. **First-wins deduplication** — duplicate skill names are resolved by declaration order. The first definition wins; duplicates are reported in `skipped`.
6. **No L1 dependency** — the provider works anywhere. Only the middleware needs the L1 runtime to intercept model calls.
