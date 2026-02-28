# @koi/file-resolution — Shared File-Resolution Utilities

Reads markdown files or inline text, resolves directory structures, enforces token budgets, and provides surrogate-safe string truncation. This is an **L0u utility package** — it depends only on `@koi/core` and has zero external dependencies. Two L2 packages (`@koi/bootstrap`, `@koi/soul`) share it instead of each reimplementing file I/O.

---

## Why It Exists

Before this package, three independent packages each had their own file-reading, token-estimating, and path-validating code:

```
BEFORE: Duplicated file I/O across packages

  @koi/bootstrap              @koi/soul
  ┌────────────────┐          ┌────────────────┐
  │ tryReadSlot()  │          │ readFile()     │
  │ isSafePath()   │          │ truncateTokens │
  │ BYTES_PER_CHAR │          │ CHARS_PER_TOKEN│
  └────────────────┘          └────────────────┘

  Problems:
  ✗  Two copies of file-read logic
  ✗  Two copies of token estimation
  ✗  No surrogate-pair safety (emoji corruption at truncation boundaries)
  ✗  Path validation duplicated between bootstrap and soul
```

```
AFTER: One shared L0u package

                      @koi/file-resolution (L0u)
                 ┌──────────────────────────────────┐
                 │  readBoundedFile()                │
                 │  truncateSafe()                   │
                 │  truncateToTokenBudget()          │
                 │  isValidPathSegment()             │
                 │  resolveContent()                 │
                 │  resolveDirectoryContent()        │
                 └──────────┬──────────┬─────────────┘
                            │          │
                 ┌──────────┘          └──────────┐
                 ▼                                ▼
        @koi/bootstrap (L2)                @koi/soul (L2)
```

Benefits:
- **One source of truth** for file I/O, token budgets, path safety, and string truncation
- **Async everywhere** — identity no longer blocks the event loop
- **Bounded I/O** — reads at most `maxChars × 4` bytes from disk, not the entire file
- **Surrogate-safe truncation** — emoji and CJK characters never split at boundaries
- **Path traversal prevention** — regex allowlist + POSIX NAME_MAX guard

---

## Architecture

### Layer position

```
L0   @koi/core              ─ types only (zero deps)
L0u  @koi/file-resolution   ─ this package
L2   @koi/bootstrap          ─ uses readBoundedFile(path, maxChars)
L2   @koi/soul               ─ uses resolveContent(), resolveDirectoryContent()
```

`@koi/file-resolution` imports only from `@koi/core` (types) and Node builtins (`node:path`, `node:fs/promises`). It never touches `@koi/engine` (L1) or any vendor SDK.

### Internal module map

```
index.ts                 ← public re-exports
│
├── read.ts              ← readBoundedFile() — core file reader
│                           isDirectory(), isInlineContent(), resolveInputPath()
│                           BoundedReadResult type
│
├── truncate.ts          ← truncateSafe() — surrogate-pair-safe string truncation
│
├── tokens.ts            ← estimateTokens(), truncateToTokenBudget()
│                           CHARS_PER_TOKEN (4), TruncateResult type
│
├── path-safety.ts       ← isValidPathSegment() — path traversal prevention
│
├── resolve-content.ts   ← resolveContent() — unified inline/file/directory resolver
│                           ResolveContentOptions, ResolvedContent types
│
└── directory.ts         ← resolveDirectoryContent() — SOUL.md directory scanner
                            SOUL_DIR_FILES, SECTION_HEADERS, ResolvedDirectory type
```

---

## Core Concepts

### Bounded vs Unbounded Reads

`readBoundedFile` has two overloads:

```
readBoundedFile(path)             → string | undefined           (unbounded)
readBoundedFile(path, maxChars)   → BoundedReadResult | undefined (bounded)
```

**Unbounded** — reads the entire file. Useful for small files (e.g. persona configs).

**Bounded** — limits disk I/O to `maxChars × 4` bytes (worst-case UTF-8), then truncates the decoded string to `maxChars` characters. Used by bootstrap (budget-controlled slots).

```
  100KB file on disk          readBoundedFile(path, 8000)

  ┌──────────────────┐
  │████████████████  │ ← reads only 32KB (8000 × 4 bytes)
  │                  │
  │  (never read)    │        Decode → truncateSafe(text, 8000)
  │                  │
  └──────────────────┘        Returns: {
                                content: "first 8000 chars...",
                                truncated: true,
                                originalSize: 102400
                              }
```

### Surrogate-Safe Truncation

JavaScript strings are UTF-16. Characters outside the BMP (emoji, some CJK) are stored as **surrogate pairs** — two code units that must stay together.

```
  "ab😀cd"  =  a  b  \uD83D \uDE00  c  d     (6 code units)
                0  1    2      3     4  5
                      ├────────┤
                      surrogate pair

  text.slice(0, 3)      →  "ab\uD83D"    ✗ dangling high surrogate!
  truncateSafe(text, 3)  →  "ab"          ✓ backs off to index 2
  truncateSafe(text, 4)  →  "ab😀"        ✓ includes the full pair
```

`truncateSafe` checks if `maxChars` lands on a high surrogate (`0xD800–0xDBFF`). If so, it backs off by one character. This is an O(1) check — one `charCodeAt` call, one `slice`.

### Path Safety

`isValidPathSegment` prevents path traversal attacks on agent names and file names:

```
Regex: /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/
Max length: 255 (POSIX NAME_MAX)

✓ "researcher"        ✓ "my-agent.v2"     ✓ "tool_config"
✗ ".."                ✗ "../etc/passwd"    ✗ ".hidden"
✗ ""                  ✗ "a".repeat(256)    ✗ "name/with/slash"
```

---

## How Each Consumer Uses It

### @koi/bootstrap — Bounded reads with character budgets

```
resolveBootstrap({ rootDir, agentName })
    │
    ├── resolveSlot("INSTRUCTIONS.md", budget: 8000)
    │     ├── isValidPathSegment(agentName)     ← path safety
    │     └── readBoundedFile(path, 8000)        ← bounded: reads ≤32KB
    │           └── truncateSafe(text, 8000)     ← surrogate-safe cut
    │
    ├── resolveSlot("TOOLS.md", budget: 4000)    ← parallel
    │     └── readBoundedFile(path, 4000)
    │
    └── resolveSlot("CONTEXT.md", budget: 4000)  ← parallel
          └── readBoundedFile(path, 4000)
```

### @koi/soul — Unified content resolution

```
createSoulMiddleware({ soul: "SOUL.md", basePath })
    │
    └── resolveContent({
          input: "SOUL.md",
          maxTokens: 4000,
          label: "soul",
          basePath,
          allowDirectory: true
        })
          │
          ├── isInlineContent("SOUL.md")  → false (no newlines)
          ├── resolveInputPath("SOUL.md", basePath) → absolute path
          ├── isDirectory(path) → true?
          │     └── resolveDirectoryContent(path)
          │           ├── readBoundedFile("SOUL.md")      ← required
          │           ├── readBoundedFile("STYLE.md")      ← optional
          │           └── readBoundedFile("INSTRUCTIONS.md")← optional
          │
          └── truncateToTokenBudget(text, 4000, "soul")
                └── truncateSafe(text, 16000)  ← 4000 tokens × 4 chars
```

---

## API Reference

### `readBoundedFile(filePath)`

Reads a file's entire text content. Returns `undefined` for missing files or directories.

| Parameter | Type | Description |
|-----------|------|-------------|
| `filePath` | `string` | Absolute or relative path |

**Returns:** `Promise<string | undefined>`

### `readBoundedFile(filePath, maxChars)`

Reads at most `maxChars × 4` bytes, then truncates to `maxChars` characters (surrogate-safe).

| Parameter | Type | Description |
|-----------|------|-------------|
| `filePath` | `string` | Absolute or relative path |
| `maxChars` | `number` | Maximum characters to return |

**Returns:** `Promise<BoundedReadResult | undefined>`

```typescript
interface BoundedReadResult {
  readonly content: string;       // Truncated content
  readonly truncated: boolean;    // True if file exceeded maxChars
  readonly originalSize: number;  // Original file size in bytes
}
```

### `truncateSafe(text, maxChars)`

Truncates a string without splitting surrogate pairs. O(1) — single boundary check.

| Parameter | Type | Description |
|-----------|------|-------------|
| `text` | `string` | Input text |
| `maxChars` | `number` | Maximum code units to keep |

**Returns:** `string`

### `truncateToTokenBudget(text, maxTokens, label)`

Truncates text to a token budget (4 chars/token). Uses `truncateSafe` internally.

| Parameter | Type | Description |
|-----------|------|-------------|
| `text` | `string` | Input text |
| `maxTokens` | `number` | Token budget |
| `label` | `string` | Label for warning message |

**Returns:** `TruncateResult`

```typescript
interface TruncateResult {
  readonly text: string;              // Possibly truncated text
  readonly warning: string | undefined; // Set when truncation occurred
}
```

### `estimateTokens(text)`

Estimates token count from text length. `Math.ceil(text.length / 4)`.

**Returns:** `number`

### `CHARS_PER_TOKEN`

Constant: `4`. Approximate characters per token used for all estimation.

### `isValidPathSegment(segment)`

Validates a path segment (file name or agent name) against traversal attacks.

| Parameter | Type | Description |
|-----------|------|-------------|
| `segment` | `string` | Path segment to validate |

**Returns:** `boolean` — `true` if segment matches `/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/` and is ≤255 chars.

### `isDirectory(path)`

Returns `true` if path is a readable directory. Returns `false` for missing paths. Throws on permission errors.

### `isInlineContent(input)`

Returns `true` if the string contains a newline character (indicating inline content rather than a file path).

### `resolveInputPath(input, basePath)`

Resolves a relative path against a base directory. Absolute paths are returned as-is.

### `resolveContent(options)`

Unified content resolver supporting three input modes:

| Mode | Detection | Behavior |
|------|-----------|----------|
| **Inline** | String contains `\n` | Used directly, truncated to token budget |
| **File** | Single-line string, not a directory | Read from disk, truncated to token budget |
| **Directory** | Path to directory (when `allowDirectory: true`) | Scans for SOUL.md + optional files |

```typescript
interface ResolveContentOptions {
  readonly input: string;              // Inline text, file path, or directory path
  readonly maxTokens: number;          // Token budget
  readonly label: string;              // Label for warnings
  readonly basePath: string;           // Base for relative paths
  readonly allowDirectory?: boolean;   // Enable directory mode (default: false)
}

interface ResolvedContent {
  readonly text: string;               // Resolved and truncated content
  readonly tokens: number;             // Estimated token count
  readonly sources: readonly string[]; // File paths read (or ["inline"])
  readonly warnings: readonly string[];// Non-fatal issues
}
```

### `resolveDirectoryContent(dirPath, label)`

Reads a structured directory containing `SOUL.md` (required), `STYLE.md`, and `INSTRUCTIONS.md` (optional). Concatenates with section headers.

```typescript
interface ResolvedDirectory {
  readonly text: string;               // Concatenated sections
  readonly sources: readonly string[]; // File paths found
  readonly warnings: readonly string[];// Missing/empty file warnings
}
```

### `SOUL_DIR_FILES`

Ordered list of files scanned in directory mode: `["SOUL.md", "STYLE.md", "INSTRUCTIONS.md"]`.

### `SECTION_HEADERS`

Map of file names to markdown section headers used in directory mode concatenation.

---

## Error Handling

```
  ┌──────────────────────┐     ┌──────────────────────┐
  │ Condition            │     │ Behavior              │
  ├──────────────────────┤     ├──────────────────────┤
  │ File not found       │ ──> │ Returns undefined     │  (ENOENT)
  │ Path is a directory  │ ──> │ Returns undefined     │  (EISDIR)
  │ Permission denied    │ ──> │ Throws with cause     │  (EACCES)
  │ Disk error           │ ──> │ Throws with cause     │  (unexpected)
  │ Invalid path segment │ ──> │ Returns false         │  (isValidPathSegment)
  └──────────────────────┘     └──────────────────────┘
```

`readBoundedFile` returns `undefined` for expected missing-file cases (ENOENT, EISDIR) and throws `Error("Failed to read file: {path}")` with ES2022 `cause` chaining for unexpected errors (permission denied, I/O failure). Consumers handle `undefined` as "file not found" without try/catch.

---

## Performance Properties

| Operation | Cost | Notes |
|-----------|------|-------|
| `readBoundedFile(path)` | O(file size) | Full file read — use for small files only |
| `readBoundedFile(path, n)` | O(n) | Reads at most `n × 4` bytes — bounded I/O |
| `truncateSafe(text, n)` | O(1) | One `charCodeAt` + one `slice` |
| `estimateTokens(text)` | O(1) | `text.length / 4` |
| `isValidPathSegment(s)` | O(1) | Regex test + length check |
| `resolveContent(opts)` | O(file size) | Single file read + truncation |
| `resolveDirectoryContent(dir)` | O(3 files) | Sequential reads of up to 3 small files |

All consumers (`@koi/bootstrap`, `@koi/soul`) resolve their files in **parallel** via `Promise.all` or `Promise.allSettled`. The package itself handles single-file resolution; parallelism is the caller's responsibility.

---

## Examples

### Bounded File Read

```typescript
import { readBoundedFile } from "@koi/file-resolution";

// Read at most 8000 characters (32KB from disk)
const result = await readBoundedFile("/path/to/INSTRUCTIONS.md", 8000);

if (result === undefined) {
  console.log("File not found");
  return;
}

console.log(`Content: ${result.content.length} chars`);
console.log(`Truncated: ${result.truncated}`);
console.log(`Original size: ${result.originalSize} bytes`);
```

### Surrogate-Safe Truncation

```typescript
import { truncateSafe } from "@koi/file-resolution";

const text = "Hello 😀 World";
truncateSafe(text, 7);   // "Hello " — backs off from high surrogate
truncateSafe(text, 8);   // "Hello 😀" — includes full emoji
```

### Token Budget Enforcement

```typescript
import { truncateToTokenBudget } from "@koi/file-resolution";

const result = truncateToTokenBudget(longText, 4000, "Agent Instructions");
// result.text — at most 16,000 characters (4000 tokens × 4 chars)
// result.warning — "Agent Instructions content truncated from ~5000 to 4000 tokens"
```

### Path Validation

```typescript
import { isValidPathSegment } from "@koi/file-resolution";

isValidPathSegment("researcher");     // true
isValidPathSegment("../etc/passwd");  // false
isValidPathSegment(".hidden");        // false
```

### Unified Content Resolution

```typescript
import { resolveContent } from "@koi/file-resolution";

// Inline mode (contains newline)
const inline = await resolveContent({
  input: "Line one\nLine two",
  maxTokens: 4000,
  label: "soul",
  basePath: "/project",
});
// inline.sources === ["inline"]

// File mode
const file = await resolveContent({
  input: "SOUL.md",
  maxTokens: 4000,
  label: "soul",
  basePath: "/project",
});
// file.sources === ["/project/SOUL.md"]

// Directory mode
const dir = await resolveContent({
  input: "agents/researcher",
  maxTokens: 4000,
  label: "soul",
  basePath: "/project",
  allowDirectory: true,
});
// dir.sources === ["/project/agents/researcher/SOUL.md", ...]
```

---

## Layer Compliance

```
L0   @koi/core ─────────────────────────────────────┐
     types only: no runtime dependency               │
                                                      │
L0u  @koi/file-resolution ◄──────────────────────────┘
     ✓ imports @koi/core types only
     ✓ uses node:path, node:fs/promises (builtins)
     ✓ uses Bun.file() (runtime built-in)
     ✗ never imports @koi/engine (L1)
     ✗ never imports any L2 package
     ✗ never imports external npm packages
```

- [x] Zero production dependencies beyond `@koi/core`
- [x] All interface properties are `readonly`
- [x] All array parameters are `readonly T[]`
- [x] No `enum`, `any`, `as Type`, or `!` in source code
- [x] ESM-only with `.js` extensions in all import paths
- [x] 100% line and function test coverage (90 tests)
