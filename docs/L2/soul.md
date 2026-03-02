# @koi/soul — Unified Agent Personality Middleware

`@koi/soul` is an L2 middleware package that injects agent personality into every model
call as a system message prefix. It composes three layers — **soul** (global personality),
**identity** (per-channel persona), and **user** (per-user context) — into a single
concatenated system message. File-based content auto-reloads when modified through the
middleware chain (HITL-approved `fs_write`).

Replaces the deprecated `@koi/middleware-soul` and `@koi/identity` packages, eliminating
~200 lines of duplicated file-resolution and hot-reload logic.

---

## Why it exists

Before `@koi/soul`, personality injection required **two separate middleware packages**
with near-identical hot-reload logic, token estimation, and system message injection:

```
BEFORE: Two middleware, two onion layers, duplicated logic

  ┌───────────────────────────────────────────────┐
  │ @koi/middleware-soul  (priority 500)          │
  │   soul.ts:     wrapModelCall + wrapToolCall   │
  │   resolve.ts:  file resolution + truncation   │
  │   config.ts:   validation                     │
  └───────────────────────────────────────────────┘
  ┌───────────────────────────────────────────────┐
  │ @koi/identity  (priority 490)                 │
  │   identity.ts: wrapModelCall + wrapToolCall   │  ← same pattern
  │   persona-map: file resolution + caching      │  ← duplicated I/O
  │   config.ts:   validation                     │  ← duplicated validation
  └───────────────────────────────────────────────┘

AFTER: One middleware, one onion layer, shared file-resolution

  ┌───────────────────────────────────────────────┐
  │ @koi/soul  (priority 500)                     │
  │   soul.ts:       unified factory              │
  │   persona-map:   per-channel identity          │
  │   state.ts:      atomic SoulState              │
  │   config.ts:     unified validation            │
  │                                               │
  │   @koi/file-resolution (L0u) ← shared utility │
  └───────────────────────────────────────────────┘
```

Benefits:
- **One middleware** at priority 500 instead of two at 490 + 500
- **One atomic state swap** instead of four mutable `let` bindings
- **Shared file resolution** via `@koi/file-resolution` (L0u utility)
- **Manifest simplification** — one `soul` entry replaces `middleware-soul` + `identity`
- **Self-modification awareness** — the middleware knows all three layers' file paths and
  auto-reloads on any tracked write

---

## Architecture

### Layer position

```
L0   @koi/core             ─ KoiMiddleware, TurnContext, InboundMessage (types only)
L0u  @koi/file-resolution  ─ resolveContent(), readBoundedFile(), truncateToTokenBudget()
L2   @koi/soul             ─ this package (no L1 dependency)
```

`@koi/soul` imports only from `@koi/core` (L0) and `@koi/file-resolution` (L0u).
It never touches `@koi/engine` (L1), keeping it fully swappable and testable
without spinning up the engine runtime.

### Internal module map

```
index.ts                 ← public re-exports
│
├── config.ts            ← CreateSoulOptions + ContentInput + ChannelPersonaConfig
│                           validateSoulConfig(), DEFAULT_*_MAX_TOKENS
│                           type guards: isRecord(), isContentInput(), isIdentityConfig()
├── persona-map.ts       ← ResolvedPersona, CachedPersona, PersonaMapResult
│                           resolvePersonaContent(), generatePersonaText()
│                           createPersonaMap(), createPersonaWatchedPaths()
├── state.ts             ← SoulState (atomic closure state)
│                           createAllWatchedPaths(), createSoulMessage()
│                           MetaInstructionSources, generateMetaInstructionText()
├── soul.ts              ← createSoulMiddleware() factory
│                           SoulMiddleware (extends KoiMiddleware with reload())
│                           enrichRequest() pure function
└── manifest.ts          ← personasFromManifest() — AgentManifest → CreateSoulOptions
```

### Lifecycle hook mapping

| Hook | What runs |
|---|---|
| `wrapModelCall` | Resolve soul message (with optional user refresh); prepend to request |
| `wrapModelStream` | Same as `wrapModelCall` but for streaming responses |
| `wrapToolCall` | After `next()`, check if `fs_write` targeted a tracked file → auto-reload |
| `describeCapabilities` | Returns `{ label: "soul", description: "Persona active — self-modification enabled" }` when `selfModify` is true and file sources exist; otherwise `"Persona active"` |

### Data flow (model call)

```
wrapModelCall(ctx, request, next)  /  wrapModelStream(ctx, request, next)
       │
       ├─ channelId = ctx.session.channelId
       ├─ lookup state.personaMap.get(channelId) → identityText | undefined
       ├─ if refreshUser: re-resolve user content from disk
       │
       ├─ createSoulMessage(soulText, identityText, userText, metaInstructionText)
       │     │
       │     ├─ filter out empty layers
       │     ├─ append meta-instruction (if non-empty)
       │     ├─ join with "\n\n"
       │     ├─ truncate to DEFAULT_TOTAL_MAX_TOKENS (8000 tokens)
       │     └─ return InboundMessage { senderId: "system:soul" }
       │
       ├─ enrichRequest(request, soulMessage)
       │     └─ prepend soulMessage to request.messages[]
       │
       └─ next(enrichedRequest)
```

### Data flow (auto-reload on fs_write)

```
wrapToolCall(ctx, request, next)
       │
       ├─ response = await next(request)     ← tool executes first
       │
       ├─ is request.toolId === "fs_write"?
       │     └─ is request.input.path in state.watchedPaths?
       │           └─ await reload()
       │                 │
       │                 ├─ Promise.all([
       │                 │    resolveSoulLayer(),
       │                 │    createPersonaMap(),
       │                 │    resolveUserLayer()
       │                 │  ])
       │                 └─ atomic state = newState
       │
       └─ return response
```

> **Why reload after `next()`?** The tool call must succeed first (it may be denied by
> permissions middleware). Only writes that pass the full middleware chain — including
> HITL approval — trigger a reload.

### Multi-channel identity routing

```
                     createSoulMiddleware({
                       soul: "SOUL.md",
                       identity: { personas: [
                         { channelId: "@koi/channel-telegram", name: "Koi Bot", ... },
                         { channelId: "@koi/channel-discord",  name: "Koi", ... },
                         { channelId: "@koi/channel-slack",    name: "Koi Assistant", ... },
                       ]},
                       user: "USER.md",
                     })

                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
         Telegram          Discord          Slack
       channelId:        channelId:       channelId:
   "@koi/channel-     "@koi/channel-   "@koi/channel-
     telegram"          discord"          slack"
              │               │               │
              ▼               ▼               ▼
   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
   │ SOUL.md      │ │ SOUL.md      │ │ SOUL.md      │
   │ ───────      │ │ ───────      │ │ ───────      │
   │ You are      │ │ You are      │ │ You are      │
   │ Koi Bot.     │ │ Koi.         │ │ Koi          │
   │              │ │              │ │ Assistant.    │
   │ <telegram    │ │ <discord     │ │ <slack       │
   │  persona>    │ │  persona>    │ │  persona>    │
   │ ───────      │ │ ───────      │ │ ───────      │
   │ USER.md      │ │ USER.md      │ │ USER.md      │
   └──────────────┘ └──────────────┘ └──────────────┘
```

Channels not in the persona map receive soul + user only (identity layer skipped).

---

## The three layers

### Layer concatenation

The final system message is built by concatenating non-empty layers in order:

```
┌──────────────────────────────────────────┐
│  1. Soul (global personality)            │  ← SOUL.md / directory / inline
│                                          │
│  2. Identity (per-channel persona)       │  ← "You are {name}.\n\n{instructions}"
│                                          │     Only if channelId matches a persona
│  3. User (per-user context)              │  ← USER.md / inline
│                                          │
│  4. Meta-instruction (self-modification) │  ← [Soul System] block
│                                          │     Only if selfModify: true + file sources exist
└──────────────────────────────────────────┘
         joined with "\n\n"
         capped at 8000 tokens (32,000 chars)
         wrapped as InboundMessage { senderId: "system:soul" }
```

Empty layers are skipped — no extra `\n\n` separators appear when a layer is absent.
The meta-instruction layer is pre-computed at factory time and included in the atomic
`SoulState` — no per-call computation.

### Soul layer (global)

Supports three input modes:

| Mode | Input | Behavior |
|---|---|---|
| **Inline** | Multi-line string (contains `\n`) | Used as-is |
| **File** | Single-line string (file path) | Read from disk, truncated to token budget |
| **Directory** | Path to a directory | Scans for `SOUL.md`, `STYLE.md`, `INSTRUCTIONS.md` and concatenates |

Default token budget: `4000` tokens.

### Identity layer (per-channel)

Each persona maps a `channelId` (e.g. `"@koi/channel-telegram"`) to:
- **name** — injected as `"You are {name}."` prefix
- **avatar** — metadata only (not injected into text)
- **instructions** — inline string or `{ path, maxTokens? }` with persona-specific instructions

Personas with no name and no instructions produce no text and are excluded from the map.

Default token budget: `2000` tokens (`DEFAULT_IDENTITY_MAX_TOKENS`).

**Token budget enforcement:** Both inline and file-based persona instructions are bounded
to `DEFAULT_IDENTITY_MAX_TOKENS` (2000 tokens ≈ 8000 chars). File reads use bounded I/O
via `readBoundedFile(path, maxChars)` — only the first `maxChars` bytes are read from disk,
preventing large persona files from consuming the context window. Inline strings are
truncated via `truncateToTokenBudget()`. Each persona can override the default budget with
`{ path: "...", maxTokens: 500 }`. When truncation occurs, a warning is emitted via
`console.warn` and included in the `PersonaMapResult.warnings` array.

### User layer (per-user)

Supports inline or file mode (not directory). With `refreshUser: true`, user content
is re-resolved from disk on every model call instead of being cached at factory time.

Default token budget: `2000` tokens.

---

## Hot-reload

All three layers support automatic hot-reload when their source files are modified
through the agent's own `fs_write` tool:

```
Agent writes to SOUL.md via fs_write
       │
       ▼
  wrapToolCall intercepts
       │
       ├─ tool executes normally (after HITL approval)
       │
       ├─ "SOUL.md" is in state.watchedPaths?  → YES
       │
       └─ reload()
            │
            ├─ re-resolve all three layers in parallel
            ├─ rebuild persona map
            ├─ rebuild watched paths set
            └─ atomic state swap
                 │
                 └─ next model call uses new content
```

**Manual reload** is also available via the `reload()` method on the returned middleware:

```typescript
const soul = await createSoulMiddleware({ ... });
await soul.reload(); // Force re-resolve all layers
```

**What is tracked:**
- Soul: all file paths from `resolveContent()` (inline sources excluded)
- Identity: all persona instruction file paths
- User: file path from `resolveContent()` (inline sources excluded)

---

## Self-modification awareness

When `selfModify` is `true` (the default) and at least one layer has a file source (not
inline), the middleware appends a `[Soul System]` meta-instruction to the system message.
This teaches the agent that it can propose changes to its own personality files, subject
to human approval.

### What the agent sees

**Single-file mode** (one soul file, no identity/user files):

```
[Soul System]
Your personality is defined in /app/SOUL.md.
You may propose changes by writing to these files.
Changes require human approval and take effect on your next response.

When to update:
- When the user gives persistent feedback about your behavior
- When you learn a pattern that should be permanent
- When the user explicitly asks you to remember something about yourself

Do NOT update for:
- One-time task preferences
- Transient conversation context
- Information that belongs in memory, not personality
```

**Multi-file mode** (soul + identity + user, with file routing hints):

```
[Soul System]
Your personality is defined in these files:
- /app/SOUL.md (global personality) — core behavior, tone, values
- /app/telegram.md (channel persona) — channel-specific style and rules
- /app/USER.md (user context) — user preferences and context
You may propose changes by writing to these files.
Changes require human approval and take effect on your next response.
...
```

### How it works

```
createState(options)
       │
       ├─ resolve all three layers in parallel
       ├─ collect file paths from each layer (filter out "inline")
       │
       ├─ generateMetaInstructionText(sources, selfModify)
       │     │
       │     ├─ selfModify === false?  → return ""
       │     ├─ no file paths at all?  → return ""
       │     ├─ single soul file?      → compact format
       │     └─ multiple files?        → grouped listing with routing hints
       │
       └─ state.metaInstructionText = result  (pre-computed, not per-call)
```

### HITL integration

The self-modification flow integrates with the middleware chain:

```
Agent decides to update SOUL.md
       │
       ▼
Agent calls fs_write("SOUL.md", "new content")
       │
       ▼
┌─ Middleware chain (onion) ──────────────────┐
│  Permissions MW → HITL approval gate        │
│       │ (approved)                          │
│       ▼                                     │
│  Soul MW (wrapToolCall)                     │
│       ├─ next(request)  ← write executes    │
│       ├─ detect tracked path                │
│       └─ reload()       ← atomic state swap │
└─────────────────────────────────────────────┘
       │
       ▼
Next model call uses updated personality
```

The write must pass the entire middleware chain — including any permissions or HITL
middleware — before it reaches the soul middleware's `wrapToolCall`. This is **structural
pre-approval**, not just a soft instruction to the LLM.

### Kill switch

Set `selfModify: false` to completely disable self-modification awareness:

```typescript
const mw = await createSoulMiddleware({
  soul: "SOUL.md",
  basePath: import.meta.dir,
  selfModify: false,  // no [Soul System] block, agent has no idea it can self-modify
});
```

When disabled:
- No `[Soul System]` meta-instruction is injected
- `describeCapabilities` returns `"Persona active"` (no mention of self-modification)
- Auto-reload on `fs_write` still works (the agent can still write files; it just
  doesn't know it has personality files to target)

### Inline content

When all layers use inline content (no files on disk), self-modification awareness is
automatically suppressed regardless of `selfModify` — there's no file path to tell the
agent about.

---

## API

### `createSoulMiddleware(options)`

```typescript
import { createSoulMiddleware } from "@koi/soul";

const mw = await createSoulMiddleware({
  soul: "SOUL.md",                    // or inline text, or directory path
  identity: {
    personas: [
      {
        channelId: "@koi/channel-telegram",
        name: "Koi Bot",
        instructions: { path: "personas/telegram.md" },
      },
    ],
  },
  user: { path: "USER.md", maxTokens: 1000 },
  basePath: import.meta.dir,
  refreshUser: false,
});
```

Returns `Promise<SoulMiddleware>` — a `KoiMiddleware` with `name: "soul"`, `priority: 500`,
and an additional `reload()` method.

### `CreateSoulOptions`

```typescript
interface CreateSoulOptions {
  /** Global agent personality: file path, inline text, or directory. */
  readonly soul?: ContentInput | undefined;
  /** Per-channel identity personas. */
  readonly identity?: { readonly personas: readonly ChannelPersonaConfig[] } | undefined;
  /** Per-user context: file path or inline text. */
  readonly user?: ContentInput | undefined;
  /** Base path for resolving relative file paths. */
  readonly basePath: string;
  /** When true, user content is re-resolved on each model call. */
  readonly refreshUser?: boolean | undefined;
  /** Enable self-modification awareness meta-instruction. Default: true. */
  readonly selfModify?: boolean | undefined;
}
```

### `ContentInput`

```typescript
type ContentInput = string | { readonly path: string; readonly maxTokens?: number };
```

When a plain `string`:
- Contains `\n` → treated as **inline content**
- Otherwise → treated as a **file path** (or directory path for soul layer)

When an `object`: `path` is always a file/directory path, `maxTokens` overrides the default budget.

### `ChannelPersonaConfig`

```typescript
interface ChannelPersonaConfig {
  /** Exact channelId to match (e.g. "@koi/channel-telegram"). */
  readonly channelId: string;
  /** Display name for this channel persona. */
  readonly name?: string;
  /** Avatar URL or path for this channel persona. */
  readonly avatar?: string;
  /** Inline instructions string or file path reference with optional token budget. */
  readonly instructions?: string | { readonly path: string; readonly maxTokens?: number };
}
```

When `instructions` is a `{ path, maxTokens? }` object, `maxTokens` overrides the default
identity token budget (2000) for this persona only. Validated as a positive finite number.

### `SoulMiddleware`

```typescript
interface SoulMiddleware extends KoiMiddleware {
  /** Re-resolves all layers from original source paths. Atomic update. */
  readonly reload: () => Promise<void>;
}
```

### `SoulState`

```typescript
interface SoulState {
  readonly soulText: string;
  readonly soulSources: readonly string[];
  readonly personaMap: ReadonlyMap<string, CachedPersona>;
  readonly userText: string;
  readonly userSources: readonly string[];
  readonly watchedPaths: ReadonlySet<string>;
  /** Pre-computed meta-instruction text for self-modification awareness. Empty when disabled. */
  readonly metaInstructionText: string;
}
```

### `MetaInstructionSources`

```typescript
interface MetaInstructionSources {
  /** Resolved soul file paths (global personality). */
  readonly soul: readonly string[];
  /** Resolved identity file paths (per-channel persona). */
  readonly identity: readonly string[];
  /** Resolved user file paths (user context). */
  readonly user: readonly string[];
}
```

### `generateMetaInstructionText(sources, selfModify)`

Pure function that produces the `[Soul System]` meta-instruction text. Returns empty
string when `selfModify` is false or no file sources exist.

```typescript
import { generateMetaInstructionText } from "@koi/soul";

const text = generateMetaInstructionText(
  { soul: ["/app/SOUL.md"], identity: ["/app/persona.md"], user: ["/app/USER.md"] },
  true,
);
// → "[Soul System]\nYour personality is defined in these files:\n- /app/SOUL.md ..."
```

Pre-computed at factory time and stored in `SoulState.metaInstructionText`. Not called
per model request.

### Token budget defaults

| Constant | Value | Layer |
|---|---|---|
| `DEFAULT_SOUL_MAX_TOKENS` | 4000 | Soul (global) |
| `DEFAULT_IDENTITY_MAX_TOKENS` | 2000 | Identity (per-channel) |
| `DEFAULT_USER_MAX_TOKENS` | 2000 | User (per-user) |
| `DEFAULT_TOTAL_MAX_TOKENS` | 8000 | Combined system message |

Token estimation uses 4 characters per token (`CHARS_PER_TOKEN = 4` from `@koi/file-resolution`).

### `validateSoulConfig(config)`

Validates untrusted config at manifest initialization time. Uses type guards (`isRecord`,
`isContentInput`, `isIdentityConfig`) — zero `as` assertions:

```typescript
import { validateSoulConfig } from "@koi/soul";

const result = validateSoulConfig(untrustedOptions);
if (!result.ok) {
  throw new Error(`invalid soul config: ${result.error.message}`);
}
const options = result.value;
```

### `personasFromManifest(manifest, options?)`

Extracts persona configs from an `AgentManifest` for easy wiring:

```typescript
import { personasFromManifest } from "@koi/soul";

const mw = await createSoulMiddleware({
  soul: "SOUL.md",
  ...personasFromManifest(manifest, { basePath: import.meta.dir }),
  basePath: import.meta.dir,
});
```

### `enrichRequest(request, soulMessage)`

Pure function — prepends a soul `InboundMessage` to a `ModelRequest.messages` array:

```typescript
import { enrichRequest } from "@koi/soul";

const enriched = enrichRequest(request, soulMessage);
// enriched.messages = [soulMessage, ...request.messages]
```

---

## Examples

### 1. Inline soul — minimal setup

```typescript
import { createSoulMiddleware } from "@koi/soul";

const mw = await createSoulMiddleware({
  soul: "You are a helpful coding assistant.\nBe concise and precise.",
  basePath: import.meta.dir,
});
// Every model call gets: "You are a helpful coding assistant.\nBe concise and precise."
```

### 2. File-based soul with directory mode

```typescript
// Given directory structure:
//   agents/my-agent/
//     SOUL.md          ← core personality
//     STYLE.md         ← writing style
//     INSTRUCTIONS.md  ← behavioral rules

const mw = await createSoulMiddleware({
  soul: "agents/my-agent",   // directory path → scans for SOUL.md, STYLE.md, INSTRUCTIONS.md
  basePath: process.cwd(),
});
```

### 3. Multi-channel identity with file-based persona

```typescript
const mw = await createSoulMiddleware({
  soul: "SOUL.md",
  identity: {
    personas: [
      {
        channelId: "@koi/channel-telegram",
        name: "Koi Bot",
        instructions: { path: "personas/telegram.md" },
      },
      {
        channelId: "@koi/channel-discord",
        name: "Koi",
        instructions: "Keep messages under 2000 characters for Discord.",
      },
      {
        channelId: "@koi/channel-slack",
        name: "Koi Assistant",
        // no instructions → just "You are Koi Assistant." injected
      },
    ],
  },
  user: "USER.md",
  basePath: import.meta.dir,
});
```

### 4. Per-persona token budget override

```typescript
const mw = await createSoulMiddleware({
  soul: "SOUL.md",
  identity: {
    personas: [
      {
        channelId: "@koi/channel-telegram",
        name: "Koi Bot",
        // Large persona file — bounded to default 2000 tokens (~8000 chars)
        instructions: { path: "personas/telegram.md" },
      },
      {
        channelId: "@koi/channel-slack",
        name: "Koi Assistant",
        // Tight budget — only 500 tokens (~2000 chars) for this persona
        instructions: { path: "personas/slack.md", maxTokens: 500 },
      },
    ],
  },
  basePath: import.meta.dir,
});
// If telegram.md is 20KB, it's truncated to ~8000 chars with a warning:
//   [soul middleware] identity persona "@koi/channel-telegram": content truncated ...
```

### 5. Manifest-driven via `@koi/starter`

```yaml
# agent.yaml
name: my-agent
version: "1.0.0"
model:
  name: claude-haiku-4-5-20251001

soul: SOUL.md

channels:
  - name: "@koi/channel-telegram"
    identity:
      name: "Koi Bot"
      instructions: "personas/telegram.md"
  - name: "@koi/channel-discord"
    identity:
      name: "Koi"

middleware:
  - name: soul
```

```typescript
import { createConfiguredKoi } from "@koi/starter";

const koi = await createConfiguredKoi({ manifestPath: "agent.yaml" });
```

### 6. Per-user refresh — dynamic user context

```typescript
const mw = await createSoulMiddleware({
  soul: "SOUL.md",
  user: { path: "USER.md", maxTokens: 500 },
  refreshUser: true,     // re-reads USER.md on every model call
  basePath: import.meta.dir,
});
// External process updates USER.md → next model call picks up new content
```

### 7. Composing with other middleware

```typescript
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import { createSoulMiddleware } from "@koi/soul";
import { createAgentMonitorMiddleware } from "@koi/agent-monitor";

const soul = await createSoulMiddleware({
  soul: "SOUL.md",
  identity: { personas: [/* ... */] },
  basePath: import.meta.dir,
});

const monitor = createAgentMonitorMiddleware({
  onAnomaly: (signal) => console.warn(signal.kind),
});

const koi = createKoi({
  adapter: createPiAdapter({ model: "claude-haiku-4-5-20251001" }),
  middleware: [soul, monitor],  // soul at 500, monitor at 350
});
```

### 8. Self-modification enabled (default)

```typescript
// selfModify defaults to true — the agent learns about its personality files
const mw = await createSoulMiddleware({
  soul: "SOUL.md",
  user: "USER.md",
  basePath: import.meta.dir,
});
// Agent sees: "[Soul System] Your personality is defined in these files: ..."
```

### 9. Self-modification disabled

```typescript
const mw = await createSoulMiddleware({
  soul: "SOUL.md",
  basePath: import.meta.dir,
  selfModify: false,  // agent has no idea it has a personality file
});
```

---

## Performance properties

| Feature | Behavior | Space |
|---|---|---|
| Soul resolution | Resolved once at factory time, cached in closure | O(file size) |
| Persona map | `Map<channelId, CachedPersona>` — O(1) lookup | O(personas) |
| Identity routing | Single `Map.get(channelId)` per model call | O(1) |
| Meta-instruction | Pre-computed once at factory time / reload | O(file paths) |
| Message assembly | Filter + join of 4 strings (soul + identity + user + meta) | O(total text) |
| Reload | Full parallel re-resolve, atomic state swap | O(file size) |
| Watched paths | `Set<string>` — O(1) membership check per `fs_write` | O(tracked files) |
| User refresh | Re-reads one file per model call (when `refreshUser: true`) | O(file size) |

All layers resolve in **parallel** via `Promise.all` — factory creation and reload
latency is bounded by the slowest single file read, not the sum.

---

## Execution model

```
createSoulMiddleware(options)
       │
       ├─ Promise.all([
       │    resolveSoulLayer(),        ← file/directory/inline → text
       │    createPersonaMap(),         ← per-channel → Map<channelId, CachedPersona>
       │    resolveUserLayer(),         ← file/inline → text
       │  ])
       │
       ├─ generateMetaInstructionText(sources, selfModify)
       │     └─ pre-computed → state.metaInstructionText
       │
       └─ return SoulMiddleware {
            name: "soul",
            priority: 500,
            wrapModelCall,
            wrapModelStream,
            wrapToolCall,
            describeCapabilities,
            reload,
          }

    ┌──────────────────────────────────────────────────────┐
    │  wrapModelCall / wrapModelStream                     │
    │    ├─ look up identity for ctx.session.channelId     │
    │    ├─ (optional) re-resolve user content              │
    │    ├─ createSoulMessage(soul, identity?, user, meta)  │
    │    ├─ enrichRequest(request, message)                 │
    │    └─ next(enrichedRequest)                           │
    │                                                      │
    │  wrapToolCall                                         │
    │    ├─ response = next(request)                        │
    │    ├─ if fs_write to tracked path → reload()          │
    │    └─ return response                                 │
    └──────────────────────────────────────────────────────┘
```

**Key properties:**

- **Pure observer for model calls** — prepends a message, never modifies model output
- **Post-execution reload** — tool completes first (including HITL), then reload triggers
- **Atomic state** — single `SoulState` object swapped as a unit, no partial updates
- **Parallel resolution** — all three layers resolve concurrently at factory time and on reload
- **Graceful reload failures** — `reload().catch()` logs the error, middleware continues
  with previous state
- **Streaming support** — `wrapModelStream` is an async generator that yields all chunks
  from the inner handler, just with an enriched request
- Middleware `priority: 500` places it after permissions (400) and monitoring (350),
  so the soul message is the innermost system prefix

---

## Layer compliance

- [x] `@koi/soul` imports only from `@koi/core` (L0) and `@koi/file-resolution` (L0u)
- [x] No `@koi/engine` (L1) or peer L2 imports in production code
- [x] All interface properties are `readonly`
- [x] All array types are `readonly T[]`
- [x] No `enum`, `any`, `as Type`, or `!` in source code
- [x] ESM-only with `.js` extensions in all import paths
- [x] No vendor types (LangGraph, OpenAI, etc.) in any source file
- [x] Zero `as` assertions — type guards used for runtime validation
- [x] Immutable patterns — `filter`/`flatMap`/spread instead of `push`/mutation
