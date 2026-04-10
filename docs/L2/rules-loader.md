# @koi/rules-loader — Hierarchical Project Rules File Injection

`@koi/rules-loader` is an L0u utility package that discovers, loads, merges, and injects hierarchical project rules files (CLAUDE.md, AGENTS.md, .koi/context.md) into the agent's system prompt. Root-level rules provide broad conventions; child-level rules append more specific overrides. As L0u, it is importable by any L1 or L2 package.

---

## Why It Exists

Agent runtimes lack project-awareness by default. Users re-explain their conventions, constraints, and domain knowledge every session. Project rules files (an emerging convention across agent runtimes) solve this: a markdown file at the repository root that the agent reads on every session.

```
Without rules:
  Session 1 ─► "Use bun, not npm" ─► agent follows
  Session 2 ─► "Use bun, not npm" ─► re-explained
  Session 3 ─► forgot to say it ─► agent uses npm

With rules-loader:
  CLAUDE.md at repo root: "Use bun, not npm"
  Session 1 ─► agent reads rules ─► uses bun
  Session 2 ─► agent reads rules ─► uses bun
  Session 3 ─► agent reads rules ─► uses bun
```

Hierarchical rules add depth: a root CLAUDE.md defines project-wide conventions, while a `src/backend/CLAUDE.md` adds API-specific constraints. The loader merges them root-first so child rules can override or extend.

---

## Architecture

### Layer Position

```
L0  @koi/core                   ─ KoiMiddleware, ModelRequest, SessionContext,
                                   TurnContext, CapabilityFragment (types only)
L0u @koi/token-estimator        ─ estimateTokens, CHARS_PER_TOKEN
L0u @koi/errors                 ─ KoiError, Result

L0u @koi/rules-loader           ─ this package (importable by L1 + L2)
    imports: @koi/core, @koi/token-estimator, @koi/errors
```

### Internal Module Map

```
index.ts                    <- public re-exports
|
+-- config.ts               <- RulesLoaderConfig, defaults, validateRulesLoaderConfig
+-- find-git-root.ts         <- findGitRoot() — walk up to .git directory
+-- discover.ts              <- discoverRulesFiles() — collect recognized filenames
+-- load.ts                  <- loadRulesFile() — read file content
+-- merge.ts                 <- mergeRulesets() — concatenate root-first, enforce budget
+-- middleware.ts             <- createRulesMiddleware() — KoiMiddleware factory
```

---

## API

### `createRulesMiddleware(config?): KoiMiddleware`

Factory that returns a middleware wiring discovery, loading, and merging into the agent session lifecycle.

```typescript
import { createRulesMiddleware } from "@koi/rules-loader";

const rules = createRulesMiddleware({
  filenames: ["CLAUDE.md", "AGENTS.md"],
  searchDirs: [".", ".koi"],
  maxTokens: 8000,
});
```

### `discoverRulesFiles(cwd, gitRoot, filenames, searchDirs): Promise<DiscoveredFile[]>`

Walk from `cwd` up to `gitRoot`, collecting recognized filenames at each directory level. Returns files ordered root-first (broadest scope first).

### `loadRulesFile(path): Promise<Result<LoadedFile, KoiError>>`

Read a single rules file from disk. Returns `Result` — file-not-found is an expected failure, not a throw.

### `mergeRulesets(files, maxTokens): MergedRuleset`

Concatenate loaded files root-first with separator markers. Enforce token budget by truncating child files first (root rules are highest priority).

### `findGitRoot(from): Promise<string | undefined>`

Walk from `from` upward to filesystem root. Return the first directory containing `.git`, or `undefined` if no git repository found.

---

## Configuration

```typescript
interface RulesLoaderConfig {
  readonly filenames?: readonly string[];   // default: ["CLAUDE.md", "AGENTS.md"]
  readonly searchDirs?: readonly string[];  // default: [".", ".koi"]
  readonly maxTokens?: number;              // default: 8000
  readonly cwd?: string;                    // default: process.cwd()
  readonly enabled?: boolean;               // default: true
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `filenames` | `["CLAUDE.md", "AGENTS.md"]` | Recognized rules filenames to scan for |
| `searchDirs` | `[".", ".koi"]` | Subdirectories to check at each level |
| `maxTokens` | `8000` | Maximum token budget for merged rules content |
| `cwd` | `process.cwd()` | Starting directory for upward walk |
| `enabled` | `true` | Set to `false` to disable rules loading entirely |

---

## Middleware Behavior

### Session Start

1. Detect git root via `findGitRoot(cwd)`
2. Walk from `cwd` to git root collecting rules files
3. Load each discovered file
4. Merge root-first with token budget enforcement
5. Cache the merged ruleset for the session
6. Emit `rules.loaded` telemetry event

### Per-Turn (onBeforeTurn)

1. `stat()` each cached file path to check mtime
2. If any file changed, re-discover + re-load + re-merge

### Model Call Injection

Prepend merged rules to `request.systemPrompt` wrapped in `<project-rules>` XML tags:

```markdown
<project-rules>
<!-- source: /repo/CLAUDE.md (depth: 0) -->
[root rules content]

---

<!-- source: /repo/src/CLAUDE.md (depth: 1) -->
[child rules content]
</project-rules>
```

### Capability Description

Returns a brief summary for the `[Active Capabilities]` banner:
`"Project rules: 3 files, 2400 tokens"`

---

## Token Budget

When merged rules exceed `maxTokens`, the loader truncates from the deepest (most specific) files first. Root-level rules are highest priority and preserved as long as possible. If even the root file exceeds the budget, it is truncated to fit.

The `truncated` flag on `MergedRuleset` indicates whether any content was dropped.

---

## Security

- Rules files are only read from directories between `cwd` and git root — no arbitrary filesystem access
- File content is treated as trusted (same trust model as CLAUDE.md in Claude Code)
- `@import` directive support is deferred to a follow-up for security review

---

## Follow-ups

- `@import` directive for including other markdown files (with cycle detection)
- Hot reload integration with `@koi/config` (#1632)
- Conditional rules with frontmatter `paths:` glob matching
- Lazy injection for nested directories
- CLI `koi rules show` command
