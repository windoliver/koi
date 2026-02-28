# Manifest Resolution

How a declarative `koi.yaml` becomes a running agent runtime.

## Overview

Koi agents are defined declaratively in YAML manifests. Manifest resolution is the pipeline that transforms a static YAML document into live runtime instances — model handlers, middleware chains, channel adapters, and engine adapters — ready for `createKoi()` to assemble into a runnable agent.

```
  koi.yaml                  @koi/resolve                        @koi/engine
  ┌──────────┐   load       ┌────────────────┐   createKoi()   ┌──────────────┐
  │ model:   │──────────>   │ resolveManifest│──────────────>  │ KoiRuntime   │
  │ soul:    │   parse +    │  ├─ model      │  middleware     │  .run()      │
  │ middleware│   validate   │  ├─ soul       │  composition   │  .dispose()  │
  │ permissions│            │  ├─ permissions │  + terminal    │              │
  │ channels:│             │  ├─ middleware  │  wiring        └──────────────┘
  │ engine:  │             │  ├─ channels   │
  └──────────┘             │  └─ engine     │
                            └────────────────┘
                                    │
                                    ▼
                            ResolvedManifest
                            { model, middleware[], channels?, engine? }
```

## The Pipeline

### 1. Load and Parse

`loadManifest()` reads YAML from disk, validates against a Zod schema, and returns a typed `LoadedManifest`:

```
  koi.yaml (on disk)
       │
       ▼
  loadManifest(path)
       │
       ├── read file (Bun.file)
       ├── YAML parse
       ├── Zod schema validation
       │   ├── name, version (required)
       │   ├── model: "provider:model-id" (required)
       │   ├── soul: string | { path, maxTokens } (optional)
       │   ├── permissions: { allow, deny, ask } (optional)
       │   ├── middleware: [{ name, options }] (optional)
       │   ├── channels: [{ name, options }] (optional)
       │   └── engine: { kind, options } (optional)
       │
       └── Result<LoadedManifest, KoiError>
```

### 2. Create Registry

All known descriptors are registered in a `ResolveRegistry` — an immutable lookup table mapping `(kind, name)` pairs to `BrickDescriptor` instances:

```
  ALL_DESCRIPTORS (static array in CLI)
       │
       ├── 17 middleware descriptors (ace, audit, call-limits, ...)
       └── 3 model provider descriptors (anthropic, openai, openrouter)
       │
       ▼
  createRegistry(descriptors)
       │
       ├── validate: no duplicate (kind, name) pairs
       ├── index by kind + name
       ├── index by kind + alias
       │
       └── ResolveRegistry { get, has, list }
```

### 3. Build Resolution Context

The resolution context provides factories with access to manifest metadata and the process environment:

```
  ResolutionContext
  ┌─────────────────────────────────────────┐
  │ manifestDir:  "/path/to/agent/"         │  ← base for relative paths
  │ manifest:     LoadedManifest            │  ← full manifest for cross-refs
  │ env:          process.env               │  ← API keys, feature flags
  │ approvalHandler?: ResolveApprovalHandler│  ← HITL for permissions "ask"
  └─────────────────────────────────────────┘
```

### 4. Resolve All Sections in Parallel

`resolveManifest()` dispatches to per-section resolvers concurrently via `Promise.all`:

```
  resolveManifest(manifest, registry, context)
       │
       ├── resolveMiddleware(manifest.middleware)    → KoiMiddleware[]
       ├── resolveSoul(manifest.soul)                → KoiMiddleware | undefined
       ├── resolvePermissions(manifest.permissions)  → KoiMiddleware | undefined
       ├── resolveModel(manifest.model)              → ModelHandler
       ├── resolveChannels(manifest.channels)        → ChannelAdapter[] | undefined
       └── resolveEngine(manifest.engine)            → EngineAdapter | undefined
       │
       ▼
  All sections succeed?
       │
       ├── YES → merge middleware (explicit + soul + permissions)
       │         sort by priority (lower = outer onion layer)
       │         return { ok: true, value: ResolvedManifest }
       │
       └── NO  → aggregateErrors(failures)
                  return { ok: false, error: KoiError }
```

### 5. Assembly via createKoi

The CLI passes the `ResolvedManifest` into `createKoi()` which:

```
  createKoi({ manifest, adapter, middleware })
       │
       ├── create agent entity (ECS)
       ├── attach tools as ECS components
       ├── compose middleware chain (onion model)
       │   ├── outer layers: lower priority middleware
       │   └── inner layers: higher priority middleware
       ├── wire callHandlers from adapter.terminals (cooperating mode)
       │   or use adapter directly (autonomous mode)
       │
       └── KoiRuntime { run(), dispose() }
```

## BrickDescriptor — The Extension Interface

Every L2 package that participates in manifest resolution exports a `BrickDescriptor`:

```
  BrickDescriptor<T>
  ┌─────────────────────────────────────────────────┐
  │ kind:             ResolveKind                    │  "middleware" | "model" | ...
  │ name:             string                         │  "@koi/soul"
  │ aliases?:         readonly string[]              │  ["soul"]
  │ optionsValidator: (input) → Result<config>       │  Zod-compatible
  │ factory:          (options, context) → T         │  Creates runtime instance
  └─────────────────────────────────────────────────┘
```

Resolution flow for a single brick:

```
  YAML entry: { name: "soul", options: { maxTokens: 2000 } }
       │
       ▼
  registry.get("middleware", "soul")
       │
       ├── lookup by name → not found
       ├── lookup by alias → found: @koi/soul descriptor
       │
       ▼
  descriptor.optionsValidator(rawOptions)
       │
       ├── ok: true  → validated options
       └── ok: false → ResolutionFailure { section, name, error }
       │
       ▼
  descriptor.factory(validatedOptions, context)
       │
       └── KoiMiddleware { name, wrapModelCall, priority }
```

## Per-Section Resolvers

### Model Resolution

The model string `"provider:model-id"` is parsed and matched against provider descriptors:

```
  manifest.model: "anthropic:claude-haiku-4-5-20251001"
       │
       ▼
  parseModelName("anthropic:claude-haiku-4-5-20251001")
       │
       ├── provider: "anthropic"
       └── model:    "claude-haiku-4-5-20251001"
       │
       ▼
  registry.get("model", "anthropic")
       │
       ▼
  factory({ model: "claude-haiku-4-5-20251001" }, context)
       │
       ├── context.env["ANTHROPIC_API_KEY"] → apiKey
       ├── createAnthropicAdapter({ apiKey })
       │
       └── ModelHandler: (request) → adapter.complete({ ...request, model })
```

### Soul Resolution

The `soul` field supports two input modes — inline text or file path:

```
  soul: |
    You are a pirate captain.            →  detectInputMode() → "inline"
    Always speak in pirate dialect.          (contains \n)

  soul: "./personas/pirate.md"           →  detectInputMode() → "file"
                                             (no \n, treated as file path)

  soul:
    path: "./personas/pirate.md"         →  object form with explicit path
    maxTokens: 2000
```

The soul descriptor creates a middleware with `wrapModelCall` that injects persona text into the system prompt.

### Permissions Resolution

```
  permissions:
    allow: ["filesystem:read", "network:*"]
    deny:  ["filesystem:write:/etc/*"]
    ask:   ["network:external:*"]
       │
       ▼
  resolvePermissions(permissions, registry, context)
       │
       └── KoiMiddleware with wrapToolCall
           ├── allow rules: auto-approve matching tool calls
           ├── deny rules: auto-reject matching tool calls
           └── ask rules: delegate to approvalHandler (HITL)
```

### Middleware Resolution

Explicit middleware entries are resolved in order, then merged with soul + permissions:

```
  middleware:
    - name: "@koi/middleware-audit"
      options: { level: "verbose" }
    - name: "@koi/middleware-call-limits"
      options: { maxModelCalls: 50 }
       │
       ▼
  resolveMiddleware(entries, registry, context)
       │
       ├── resolve each entry via resolveOne()
       │   (registry lookup → validate → factory)
       │
       └── KoiMiddleware[]

  Final merge:
    [explicit...] + [soul?] + [permissions?]
       │
       ▼
  sort by priority (lower number = outer layer = runs first)
```

### Channel and Engine Resolution

Optional sections — when absent, CLI applies defaults:

```
  channels: undefined  →  CLI uses @koi/channel-cli
  engine:   undefined  →  CLI uses createLoopAdapter (ReAct loop)

  engine:
    kind: "pi"         →  resolveEngine() → createPiAdapter (cooperating mode)
    options: { ... }
```

## Error Handling

Resolution failures are aggregated — all sections run even if some fail, providing a complete error report:

```
  Section failures:
    middleware[2]: "@koi/middleware-nonexistent" — descriptor not found
    model: "unknown-provider:gpt-4" — no provider "unknown-provider"
       │
       ▼
  aggregateErrors(failures)
       │
       └── KoiError {
             code: "RESOLUTION",
             message: "2 resolution failures:\n  - middleware: ...\n  - model: ...",
             retryable: false
           }
       │
       ▼
  formatResolutionError(error) → human-readable stderr output
```

## Example Manifests

### Minimal agent

```yaml
name: echo-bot
version: "1.0"
model: anthropic:claude-haiku-4-5-20251001
```

Resolves to: `{ model: ModelHandler, middleware: [] }`.

### Agent with soul and middleware

```yaml
name: pirate-bot
version: "1.0"
model: anthropic:claude-haiku-4-5-20251001
soul: |
  You are a pirate captain.
  Always speak in pirate dialect.
permissions:
  allow: ["*"]
middleware:
  - name: "@koi/middleware-audit"
  - name: "@koi/middleware-call-limits"
    options:
      maxModelCalls: 50
```

Resolves to: `{ model: ModelHandler, middleware: [audit, call-limits, soul, permissions] }` (sorted by priority).

### Agent with pi engine

```yaml
name: pi-agent
version: "1.0"
model: anthropic:claude-haiku-4-5-20251001
engine:
  kind: pi
```

Resolves to: `{ model: ModelHandler, middleware: [], engine: PiEngineAdapter }`.

## Package Map

```
  @koi/manifest (L0u)
  └── loadManifest(), loadManifestFromString()     (loader.ts)
      YAML parsing + Zod schema validation

  @koi/resolve (L0u)
  ├── types: BrickDescriptor, ResolveRegistry,     (types.ts)
  │          ResolutionContext, ResolvedManifest
  ├── createRegistry()                             (registry.ts)
  ├── resolveManifest()                            (resolve-manifest.ts)
  ├── resolveMiddleware()                          (resolve-middleware.ts)
  ├── resolveModel(), parseModelName()             (resolve-model.ts)
  ├── resolveSoul()                                (resolve-soul.ts)
  ├── resolvePermissions()                         (resolve-permissions.ts)
  ├── resolveChannels()                            (resolve-channels.ts)
  ├── resolveEngine()                              (resolve-engine.ts)
  └── aggregateErrors(), formatResolutionError()   (errors.ts)

  @koi/middleware-* (L2)
  └── Each exports: descriptor (BrickDescriptor)   (descriptor.ts)

  @koi/model-router (L2)
  └── createAnthropicAdapter, createOpenAIAdapter, (index.ts)
      createOpenRouterAdapter

  @koi/cli (L3)
  └── resolveAgent(): CLI orchestration            (resolve-agent.ts)
      ALL_DESCRIPTORS, PROVIDER_FACTORIES

  @koi/engine (L1)
  └── createKoi(): final assembly                  (koi.ts)
      middleware composition + terminal wiring
```

## Testing

The E2E test at `tests/e2e/manifest-resolve-e2e.test.ts` validates the full pipeline with real Anthropic API calls:

```
  Test                                  What it validates
  ────                                  ─────────────────
  Minimal manifest → LLM response       Full assembly path end-to-end
  Soul + permissions middleware          Descriptor factories produce working middleware
  Call-limits enforcement                Middleware intercepts and limits model calls
  Multi-middleware composition           Multiple middleware resolved and composed
  Tool call through createKoi            Tool execution via loop adapter + middleware
  Resolution failure → graceful error    Missing descriptor returns Result error
  Pi adapter through createKoi           Cooperating-mode engine through L1 assembly
```

Run: `E2E_TESTS=1 bun test tests/e2e/manifest-resolve-e2e.test.ts`

## Related

- [Koi Architecture](./Koi.md) — full system overview
- [Brick Auto-Discovery](./brick-auto-discovery.md) — runtime brick forging (complementary pipeline)
- [#360](https://github.com/windoliver/koi/issues/360) — manifest auto-resolution implementation issue
