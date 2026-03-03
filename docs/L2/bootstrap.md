# @koi/bootstrap — Agent Bootstrap File Resolver

Resolves markdown instruction files from a hierarchical `.koi/` directory structure and outputs structured text sources for the `@koi/context` hydrator middleware. Agents use this to load customized instructions, tool guidelines, and domain context at startup — with agent-specific overrides, character-budget truncation, and path-traversal prevention built in.

---

## Why It Exists

Koi agents need bootstrap context: system instructions, tool usage guidelines, and domain-specific knowledge. These live as markdown files in a `.koi/` directory convention. Without this package, every agent would need to:

- Walk the file hierarchy and resolve overrides
- Enforce size budgets to avoid blowing context windows
- Validate paths to prevent traversal attacks
- Convert raw file content into the `TextSource` shape the context hydrator expects

`@koi/bootstrap` handles all of this in a single `resolveBootstrap()` call.

---

## What This Enables

### Before: Manual Wiring

Every project had to write CLI-level glue code to connect bootstrap file resolution to the context hydrator:

```typescript
// Before — manual glue in every project
const result = await resolveBootstrap({ rootDir: ".", agentName: manifest.name });
if (result.ok) {
  const sources = result.value.sources.map(s => ({ ...s }));
  const config = { sources: [...sources, ...manifest.context.sources] };
  const ext = createContextExtension(config);
  // ... wire into createKoi()
}
```

### After: One Line in koi.yaml

```yaml
context:
  bootstrap: true
```

The CLI resolves `.koi/` files automatically, merges them with explicit sources, and feeds the combined config into the hydrator. Zero manual wiring. Agent-specific overrides, budget truncation, and error recovery all work out of the box.

### What You Get

- **Project-level instructions** — `.koi/INSTRUCTIONS.md` auto-loaded for every agent
- **Agent-specific overrides** — `.koi/agents/<name>/INSTRUCTIONS.md` takes priority
- **Mix bootstrap + explicit sources** — bootstrap files prepend to manual `sources`
- **Non-fatal** — missing files or errors produce warnings, agent starts anyway
- **Custom slots** — swap default files for project-specific ones via object config

---

## Architecture

`@koi/bootstrap` is an **L2 feature package** — it depends only on L0 (`@koi/core`) and L0-utility packages (`@koi/errors`, `@koi/hash`).

```
┌──────────────────────────────────────────────────────┐
│  @koi/bootstrap  (L2)                                │
│                                                      │
│  resolve.ts  ← orchestrator: parallel slot resolution │
│  slot.ts     ← single-file read, path validation     │
│  types.ts    ← BootstrapConfig, Slot, Result types   │
│  index.ts    ← public API surface                    │
│                                                      │
├──────────────────────────────────────────────────────┤
│  Dependencies                                        │
│                                                      │
│  @koi/core             (L0)   KoiError, Result types │
│  @koi/file-resolution  (L0u)  readBoundedFile(),     │
│                                isValidPathSegment()   │
│  @koi/hash             (L0u)  fnv1a() content hashing│
└──────────────────────────────────────────────────────┘
```

---

## File Hierarchy Convention

The package expects this directory layout under your project root:

```
<rootDir>/
  .koi/
    INSTRUCTIONS.md          ← project-level agent instructions
    TOOLS.md                 ← project-level tool guidelines
    CONTEXT.md               ← project-level domain context
    agents/
      <agentName>/
        INSTRUCTIONS.md      ← agent-specific override
        TOOLS.md             ← agent-specific override
        CONTEXT.md           ← agent-specific override
```

**Resolution priority:** Agent-specific files are checked first. If found, the project-level file is *not* read (no concatenation — override is total). If the agent-specific file doesn't exist, the project-level file is used as fallback.

```
resolveBootstrap({ rootDir, agentName: "researcher" })

  INSTRUCTIONS.md:
    1. {rootDir}/.koi/agents/researcher/INSTRUCTIONS.md  ← checked first
    2. {rootDir}/.koi/INSTRUCTIONS.md                    ← fallback

  TOOLS.md:
    1. {rootDir}/.koi/agents/researcher/TOOLS.md
    2. {rootDir}/.koi/TOOLS.md

  CONTEXT.md:
    1. {rootDir}/.koi/agents/researcher/CONTEXT.md
    2. {rootDir}/.koi/CONTEXT.md
```

---

## Default Slots

Three slots are resolved by default, each with a character budget:

| Slot | File | Label | Budget | Purpose |
|------|------|-------|--------|---------|
| 0 | `INSTRUCTIONS.md` | `"Agent Instructions"` | 8,000 chars | Core agent behavior and system instructions |
| 1 | `TOOLS.md` | `"Tool Guidelines"` | 4,000 chars | Tool usage guidelines and constraints |
| 2 | `CONTEXT.md` | `"Domain Context"` | 4,000 chars | Domain knowledge and project context |

Total default budget: ~16,000 characters across all slots. Custom slots can override these entirely.

---

## How Resolution Works

```
resolveBootstrap(config)
  │
  ├── validate rootDir (non-empty)
  │
  ├── Promise.allSettled() ─── resolveSlot(slot[0]) ──┐
  │                        ├── resolveSlot(slot[1]) ──┤  parallel
  │                        └── resolveSlot(slot[2]) ──┘
  │
  ├── for each settled result:
  │     rejected?     → add warning, skip
  │     undefined?    → skip (file not found)
  │     size guard?   → originalSize > budget * 8 → add warning, skip
  │     truncated?    → add warning, include truncated content
  │     ok?           → include in sources
  │
  └── return { sources, resolved, warnings }
```

### Size Guards and Truncation

Two levels of protection prevent oversized files from blowing context windows:

1. **Size guard** — Files larger than `budget * 8` bytes are skipped entirely (warning added). The 8x factor accounts for worst-case UTF-8 (4 bytes/char) with generous headroom.

2. **Truncation** — Files within the size guard but exceeding the character budget are truncated to exactly `budget` characters. The `truncated` flag is set on the `ResolvedSlot` metadata and a warning is added.

```
  File size check:
    > budget * 8 bytes  →  SKIP (too large, warning)
    ≤ budget * 8 bytes  →  read up to budget * 4 bytes
                            truncate to budget characters
                            if truncated → warning
```

### Path Safety

Both `agentName` and `fileName` are validated against a strict allowlist regex:

```
/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
```

Segments containing `..`, `/`, `\`, or other special characters are silently rejected (returns `undefined`). No path traversal is possible.

**Important:** If `agentName` fails validation, the entire slot is skipped — the project-level fallback is also not read. This is intentional: an invalid agent name may indicate a misconfiguration or injection attempt.

---

## Output Format

`resolveBootstrap()` returns a `Result<BootstrapResult, KoiError>`:

```typescript
interface BootstrapResult {
  readonly sources: readonly BootstrapTextSource[]  // For context hydrator
  readonly resolved: readonly ResolvedSlot[]        // Resolution metadata
  readonly warnings: readonly string[]              // Non-fatal issues
}
```

Each source is a structured text block compatible with `@koi/context`:

```typescript
interface BootstrapTextSource {
  readonly kind: "text"       // Discriminator
  readonly text: string       // File content (truncated to budget)
  readonly label: string      // Display name (e.g., "Agent Instructions")
  readonly priority: number   // Slot index (0, 1, 2...)
}
```

Each resolved slot carries metadata for inspection:

```typescript
interface ResolvedSlot {
  readonly fileName: string       // e.g., "INSTRUCTIONS.md"
  readonly label: string          // e.g., "Agent Instructions"
  readonly content: string        // File content (truncated)
  readonly contentHash: number    // FNV-1a hash of content
  readonly resolvedFrom: string   // Full path where file was found
  readonly truncated: boolean     // True if content exceeded budget
  readonly originalSize: number   // Original file size in bytes
}
```

---

## API Reference

### `resolveBootstrap(config)`

Main entry point. Resolves all slots in parallel and returns structured output.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config.rootDir` | `string` | — | Root directory to search from (must be non-empty) |
| `config.agentName` | `string` | `undefined` | Agent subdirectory name for overrides |
| `config.slots` | `readonly BootstrapSlot[]` | `DEFAULT_SLOTS` | Custom slot definitions |

**Returns:** `Promise<Result<BootstrapResult, KoiError>>`

- `ok: true` — resolution succeeded (even if no files found — empty sources is valid)
- `ok: false` — validation error (empty `rootDir`)

### `DEFAULT_SLOTS`

Pre-defined slot array: `INSTRUCTIONS.md` (8k), `TOOLS.md` (4k), `CONTEXT.md` (4k).

### Types

| Type | Description |
|------|-------------|
| `BootstrapConfig` | Input config: `rootDir`, optional `agentName` and `slots` |
| `BootstrapSlot` | Slot definition: `fileName`, `label`, `budget` |
| `BootstrapTextSource` | Output text source for context hydrator |
| `ResolvedSlot` | Resolution metadata: path, hash, truncation info |
| `BootstrapResult` | Aggregated result: `sources`, `resolved`, `warnings` |
| `BootstrapResolveResult` | `Result<BootstrapResult, KoiError>` |

---

## Error Handling

```
  ┌──────────────────────┐     ┌──────────────┐
  │ Issue                │     │ Behavior     │
  ├──────────────────────┤     ├──────────────┤
  │ Empty rootDir        │ ──> │ Result error │  code: "VALIDATION"
  │ File not found       │ ──> │ Skip (silent)│  no warning
  │ File too large       │ ──> │ Skip + warn  │  > budget * 8 bytes
  │ File truncated       │ ──> │ Include + warn│  > budget characters
  │ Path traversal       │ ──> │ Skip (silent)│  invalid segments
  │ Filesystem error     │ ──> │ Skip + warn  │  wrapped via mapFsError()
  └──────────────────────┘     └──────────────┘
```

Non-fatal issues are collected as warnings — resolution continues for remaining slots. Only `rootDir` validation returns `ok: false`. Everything else (missing files, oversized files, filesystem errors, path validation failures) is either silently skipped or produces a warning.

---

## Examples

### Load Default Bootstrap Files

```typescript
import { resolveBootstrap } from "@koi/bootstrap";

const result = await resolveBootstrap({ rootDir: "/my/project" });
if (!result.ok) {
  console.error("Bootstrap failed:", result.error.message);
  return;
}

// Sources ready for @koi/context hydrator
for (const source of result.value.sources) {
  console.log(`[${source.label}] ${source.text.length} chars`);
}

// Check for warnings (truncation, oversized files)
for (const warning of result.value.warnings) {
  console.warn(warning);
}
```

### Agent-Specific Overrides

```typescript
import { resolveBootstrap } from "@koi/bootstrap";

// Checks .koi/agents/researcher/ first, falls back to .koi/
const result = await resolveBootstrap({
  rootDir: "/my/project",
  agentName: "researcher",
});
```

### Custom Slots

```typescript
import { resolveBootstrap } from "@koi/bootstrap";
import type { BootstrapSlot } from "@koi/bootstrap";

const customSlots: readonly BootstrapSlot[] = [
  { fileName: "GUIDELINES.md", label: "Custom Guidelines", budget: 3_000 },
  { fileName: "EXAMPLES.md", label: "Usage Examples", budget: 5_000 },
];

const result = await resolveBootstrap({
  rootDir: "/my/project",
  slots: customSlots,
});
```

### Manifest Auto-Resolution (Zero Glue Code)

The recommended way to use bootstrap. Add `context.bootstrap` to your `koi.yaml` — the CLI auto-resolves `.koi/` files and feeds them to the context hydrator at startup:

```yaml
# koi.yaml
name: researcher
version: 1.0.0
model: anthropic:claude-sonnet-4-5-20250929

context:
  bootstrap: true
```

That's it. On `koi start`, the CLI:
1. Reads `bootstrap: true` from the manifest
2. Calls `resolveBootstrap()` with `rootDir` = manifest directory, `agentName` = manifest name
3. Maps `BootstrapTextSource[]` → `TextSource[]`
4. Prepends them to any explicit `sources` in the context config
5. Passes the merged config to `createContextExtension()` → hydrator pipeline

#### Object Form

Override defaults with the object form:

```yaml
context:
  bootstrap:
    rootDir: ./config           # relative to manifest file location
    agentName: my-custom-agent  # override agent-specific directory name
    slots:                      # custom file slots (replaces defaults)
      - fileName: GUIDELINES.md
        label: Custom Guidelines
        budget: 5000
      - fileName: EXAMPLES.md

  # Mix with explicit sources — bootstrap sources come first
  sources:
    - kind: memory
      query: "user preferences"
    - kind: tool_schema
```

#### agentName Resolution

| Config | Behavior |
|--------|----------|
| `bootstrap: true` | Uses `manifest.name` as agentName |
| `bootstrap: { agentName: "custom" }` | Uses `"custom"` |
| `bootstrap: { agentName: null }` | Disables agent-specific resolution (project-level only) |
| `bootstrap: {}` | Uses `manifest.name` (same as `true`) |

#### Error Handling

Bootstrap resolution is **non-fatal**. If `.koi/` files are missing or resolution fails:
- Warnings are printed to stderr
- Empty sources are returned
- The agent starts normally with any remaining explicit sources

```
warn: [bootstrap] "Agent Instructions" truncated to 8000 characters (original: 45000 bytes)
warn: Bootstrap resolution failed: rootDir must be a non-empty string
```

### Manual Integration with @koi/context

For programmatic use outside the CLI (e.g., custom harnesses), wire the packages manually:

```typescript
import { resolveBootstrap } from "@koi/bootstrap";
import { createContextHydrator } from "@koi/context";

const bootstrapResult = await resolveBootstrap({
  rootDir: "/my/project",
  agentName: "researcher",
});

if (bootstrapResult.ok) {
  const middleware = createContextHydrator({
    sources: bootstrapResult.value.sources,
  });
  // Include middleware in your agent's middleware stack
}
```

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────┐
    KoiError, Result, RETRYABLE_DEFAULTS             │
                                                     │
L0u @koi/errors ────────────────────┐               │
    mapFsError() for FS errors      │               │
                                    │               │
L0u @koi/hash ─────────────┐       │               │
    fnv1a() content hashing │       │               │
                            ▼       ▼               ▼
L2  @koi/bootstrap ◄───────┴───────┴───────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ Bun.file() is a runtime built-in
```

**Dev-only dependency** (`@koi/context`) is used in integration tests but is not a runtime import.
