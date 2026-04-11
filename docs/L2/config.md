# @koi/config — Runtime Policy & Hot-Reload Configuration

Provides Zod schemas, YAML/JSON loading with env interpolation, a reactive config store, `$include` composition, file watching for hot-reload, and a bridge from `KoiConfig` to engine options. Imports from `@koi/core` (L0) and `@koi/validation` (L0u) only.

---

## Why It Exists

Every Koi agent needs runtime configuration: limits, telemetry, loop detection, spawn policies, model routing, feature flags. Without a shared config package, every consumer would reimplement file loading, validation, env var expansion, and change notifications.

`@koi/config` extracts all of that into one L0u package that any layer can depend on.

---

## What This Enables

### The Full Pipeline

```
 ┌─────────────────────────────────────────────────────────┐
 │                    Config Files (YAML / JSON)            │
 │                                                          │
 │   koi.yaml              base.yaml         prod.yaml      │
 │   ┌──────────────┐     ┌──────────────┐  ┌───────────┐  │
 │   │ $include:     │────▶│ logLevel: info│  │ telemetry:│  │
 │   │   - base.yaml │     │ limits:      │  │  enabled: │  │
 │   │   - prod.yaml │────▶│   maxTurns:25│  │    true   │  │
 │   │ limits:       │     └──────────────┘  └───────────┘  │
 │   │   maxTurns:100│                                      │
 │   └──────────────┘                                       │
 └─────────────────────────┬────────────────────────────────┘
                           │
                  ┌────────▼────────┐
                  │  interpolateEnv  │  ${API_KEY:-fallback}
                  │  process.env ──▶ │  ${LOG_LEVEL:-info}
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │ processIncludes  │  Cycle detection
                  │  Max depth: 5   │  Diamond graphs OK
                  │  Main wins      │  on conflict
                  └────────┬────────┘
                           │
                  ┌────────▼────────┐
                  │  deepMerge       │  Immutable merge
                  │  base + override │  No prototype pollution
                  │  Arrays replaced │  (not concatenated)
                  └────────┬────────┘
                           │
              ┌────────────▼─────────────┐
              │  validateKoiConfig (Zod)  │
              │  8 sections validated     │
              │  Returns Result<T, Error> │
              └────────────┬─────────────┘
                           │
              ┌────────────▼─────────────┐
              │  createConfigStore()      │
              │  ┌─────────────────────┐  │
              │  │  TODAY'S RULES      │  │
              │  │  (Object.freeze'd)  │  │
              │  │                     │  │
              │  │  .get()   → O(1)   │  │
              │  │  .set()   → freeze │  │
              │  │  .subscribe() sync │  │
              │  └─────────────────────┘  │
              └────────────┬──────────────┘
                           │
            ┌──────────────┼──────────────┐
            ▼              ▼              ▼
     ┌────────────┐ ┌────────────┐ ┌────────────┐
     │ Subscriber │ │ Subscriber │ │ Subscriber │
     │ (limits)   │ │ (telemetry)│ │ (features) │
     │ ref-equal  │ │ ref-equal  │ │ ref-equal  │
     │ skip check │ │ skip check │ │ skip check │
     └────────────┘ └────────────┘ └────────────┘
```

### Hot-Reload Lifecycle

A successful reload follows a fixed, serialized pipeline. Reloads are single-flight: rapid `fs.watch` events are coalesced into at most one trailing reload, so store updates never interleave.

```
  fs.watch event (or explicit reload() call)
        │
        ▼
  single-flight gate
        │
        ▼
  events.notify({ kind: "attempted" })
        │
        ▼
  loadConfig → deepMerge → validateKoiConfig
        │
        ├── load error ─▶ events.notify({ kind: "rejected", reason: "load" })
        │
        ├── validation error ─▶ events.notify({ kind: "rejected", reason: "validation" })
        │
        ▼
  diffConfig(store.get(), validated) → changedPaths[]
        │
        ├── empty diff ─▶ events.notify({ kind: "applied", changedPaths: [] })
        │                 (no "changed" event — nothing to re-bind)
        │
        ▼
  classifyChangedPaths → { hot, restart }
        │
        ├── any restart ─▶ events.notify({ kind: "rejected", reason: "restart-required" })
        │                  (all-or-nothing — hot fields are NOT applied either)
        │
        ▼
  store.set(next)                      ← triggers low-level store.subscribe listeners
  events.notify({ kind: "applied" })   ← telemetry sinks
  events.notify({ kind: "changed" })   ← ConfigConsumer.onConfigChange via registerConsumer
```

**Bootstrap exception:** the very first successful reload after `createConfigManager()` is treated as the initial bind. All fields are applied regardless of classification, since no process state has yet bound to the defaults. The restart-required gate only enforces on reloads *after* that first bind.

### Field Classification

Config sections are declared `hot` (safe to hot-apply) or `restart` (requires a restart) in `FIELD_CLASSIFICATION`. Unclassified sections default to `restart` — **fail closed**. An exhaustiveness test ensures every top-level section of `DEFAULT_KOI_CONFIG` is either in the table or explicitly in `UNCLASSIFIED_SECTIONS`.

| Section | Class | Rationale |
|---|---|---|
| `logLevel` | hot | Only affects future log emissions |
| `loopDetection` | hot | Runtime heuristic recomputed per turn |
| `modelRouter` | hot | Next model call picks up new routing |
| `features` | hot | Feature flags checked lazily |
| `telemetry` | restart | Would need to tear down and re-establish OTLP exporter |
| `limits` | restart | Mid-flight concurrency / budget changes are unsafe |
| `spawn`, `forge` | unclassified | Defaults to `restart`; opted out pending deliberate classification |

Adding a new top-level section without classifying it will fail CI (`classification.test.ts` exhaustiveness check). This is intentional: a field that hasn't been deliberately reviewed gets the conservative treatment.

### ConfigConsumer contract

Feature packages that want to re-bind on config changes implement `ConfigConsumer` and register via `ConfigManager.registerConsumer()`:

```ts
const unsubscribe = mgr.registerConsumer({
  onConfigChange: ({ prev, next, changedPaths }) => {
    if (changedPaths.some((p) => p.startsWith("modelRouter"))) {
      rebindModelTargets(next.modelRouter.targets);
    }
  },
});
```

**Contract semantics — read this before using it:**

- **Fire-and-forget.** Consumers cannot veto a hot-apply. If `onConfigChange` throws or rejects, the error is swallowed by the underlying `ChangeNotifier` and other consumers still run.
- **Post-apply only.** Consumers run *after* `store.set()` has committed the new value. They observe the change, they don't gate it.
- **One authoritative channel.** Feature-level code MUST pick between `registerConsumer` (carries `changedPaths`, fires on successful reloads only) and `store.subscribe` (raw, synchronous, inside `store.set`). The latter is documented as low-level and intended for kernel-internal bootstrapping only. Using both on the same consumer will produce duplicate and out-of-order signals.
- **No rejection path.** If a consumer genuinely cannot apply a change (e.g. a model adapter that needs to drain an in-flight stream), the current recommendation is to classify that section as `restart` and require a process restart. A `ConfigValidator` interface with an awaited pre-apply phase can be added in a follow-up PR if a real use case emerges.

### Event Bus

All lifecycle events flow through `ConfigManager.events`, a typed `ChangeNotifier<ConfigReloadEvent>` where `ConfigReloadEvent` is a discriminated union:

| `kind` | Fires when | Payload |
|---|---|---|
| `attempted` | Every reload call (before load) | `filePath` |
| `applied` | Successful reload (hot fields committed OR empty diff) | `filePath`, `prev`, `next`, `changedPaths` |
| `rejected` | Load error, validation error, or restart-required gate | `filePath`, `reason`, `error`, optional `restartRequiredPaths` |
| `changed` | Successful reload with non-empty diff, after `applied` | `filePath`, `prev`, `next`, `changedPaths` |

Telemetry sinks subscribe to `attempted` / `applied` / `rejected`. Feature consumers use `registerConsumer` (which internally filters to `kind === "changed"`).

### Rename-on-save handling

Atomic-save editors (vim, VS Code) replace the target inode via `write tmp → rename tmp over target`. On macOS this causes `fs.watch` to silently continue pointing at the dead inode, which means no further `change` events ever arrive. The watcher detects `eventType === "rename"`, schedules a reload, closes the stale watcher, and re-arms onto the new file with retry backoff (50/100/200 ms). If the file is permanently gone after all retries, `onError` is called and the watcher closes.

### Known Limitations

- **`$include`d files ARE auto-watched once successfully loaded.** `ConfigManager.watch()` arms a watcher for every file in the resolved include graph (root + transitively resolved `$include` entries). Edits to any of those files trigger a reload, and the watcher set is rebuilt after every successful reload so edits to newly-added or newly-removed includes are picked up. Rejected reloads that change the graph also cover the union of old + candidate files so a fix to a rejected existing file still recovers without re-touching the root.

- **Newly-referenced *missing* `$include` files do NOT self-recover.** If you edit the root config to add `$include: ["new.yaml"]` and `new.yaml` does not exist, the reload attempt fires a `rejected` event with `NOT_FOUND` as expected — but the missing path is NOT added to the watched file set (doing so would either require one perpetual retry loop per missing path or a directory-level watcher; both are out of scope). To recover, create the missing file AND re-touch the root config (or any other already-watched file in the include graph). The `rejected` event's error context includes the missing path so operators can see exactly what's needed. This narrower contract is locked in by a regression test; revisit if a bounded directory-watch mechanism is added later.

- **All-or-nothing reloads.** If a single edit touches both a hot and a restart-required field, the entire reload is rejected and the old config is retained (including the hot field). Split edits if you need the hot change to land immediately.

- **No consumer-side veto.** `ConfigConsumer.onConfigChange` is best-effort. See the contract section above.

### Config Composition via `$include`

```
                 koi.yaml
                ┌────────────────┐
                │ $include:      │
                │   - base.yaml  │──────┐
                │   - prod.yaml  │──┐   │
                │ logLevel: error│  │   │
                └───────┬────────┘  │   │
                        │           │   │
      main wins ◀───────┘           │   │
                                    │   │
           ┌────────────────────────┘   │
           ▼                            ▼
  ┌────────────────┐          ┌────────────────┐
  │  prod.yaml     │          │  base.yaml     │
  │  $include:     │          │  logLevel: info │
  │   - base.yaml  │─ ─ ─ ┐  │  limits:       │
  │  telemetry:    │       │  │   maxTurns: 25 │
  │   enabled: true│       │  └────────────────┘
  └────────────────┘       │          ▲
                           └ ─ ─ ─ ─ ─┘
                           Diamond OK!
                           Cycle = error

  MERGE ORDER (last wins):
  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
  │ DEFAULTS │ ◀ │ base.yaml│ ◀ │ prod.yaml│ ◀ │ koi.yaml │
  │ (code)   │   │ (deepest)│   │ (middle) │   │ (main)   │
  └──────────┘   └──────────┘   └──────────┘   └──────────┘
      lowest                                      highest
      priority                                    priority
```

---

## Architecture

`@koi/config` is an **L0-utility (L0u) package**. It implements contracts defined in `@koi/core` (L0) using `@koi/validation` (L0u) for Zod integration.

```
L0  @koi/core ──────────────────────────────────────────────┐
    KoiConfig, ConfigStore<T>, ConfigListener, Result<T,E>   │
    (types only)                                              │
                                                              │
L0u @koi/validation ──────────────────┐                      │
    validateWith()                    │                      │
                                      ▼                      ▼
L0u @koi/config ◄────────────────────┴──────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ one external dep: zod
               │
    ┌──────────┼──────────────┐──────────────┐
    ▼          ▼              ▼              ▼
L1 engine   L2 packages   L0u peers     anywhere
   (uses)      (use)        (use)        that needs config
```

### Module Map

```
@koi/config/src/
├── loader.ts           ← loadConfig(), loadConfigFromString(), interpolateEnv()
├── include.ts          ← processIncludes() — $include with cycle detection
├── schema.ts           ← Zod schemas for all 8 KoiConfig sections
├── json-schema.ts      ← getKoiConfigJsonSchema() for IDE support
├── resolve.ts          ← resolveConfig<T>() — validate + merge with defaults
├── resolve-options.ts  ← resolveKoiOptions() — KoiConfig → engine bridge
├── merge.ts            ← deepMerge() — immutable recursive merge
├── store.ts            ← createConfigStore() — reactive get/set/subscribe
├── select.ts           ← selectConfig() — slice subscription with ref-equality
├── watcher.ts          ← watchConfigFile() — debounced fs.watch
├── reload.ts           ← createConfigManager() — wires everything together
├── mask.ts             ← maskConfig() — redact sensitive fields for logging
└── index.ts            ← public API surface
```

---

## How It Works

### 1. Loading: File → Raw Object

`loadConfig(filePath)` reads a YAML or JSON file, interpolates environment variables, processes `$include` directives, and returns a raw parsed object.

```
  koi.yaml on disk
  ┌──────────────────────────┐
  │ logLevel: ${LOG:-info}   │
  │ limits:                  │
  │   maxTurns: ${MAX:-25}   │
  │ $include:                │
  │   - base.yaml            │
  └────────────┬─────────────┘
               │
     ┌─────────▼──────────┐
     │  Bun.file().text()  │    read raw string
     └─────────┬──────────┘
               │
     ┌─────────▼──────────┐
     │  interpolateEnv()   │    ${LOG:-info} → "info"
     │  regex: ${VAR:-def} │    ${MAX:-25}  → "25"
     └─────────┬──────────┘
               │
     ┌─────────▼──────────┐
     │  Bun.YAML.parse()   │    string → object
     │  or JSON.parse()    │    (by file extension)
     └─────────┬──────────┘
               │
     ┌─────────▼──────────┐
     │  processIncludes()  │    resolve $include paths
     │  deepMerge() chain  │    merge included files
     │  cycle detection    │    ancestor tracking
     └─────────┬──────────┘
               │
               ▼
     Result<Record<string, unknown>, KoiError>
```

### 2. Validation: Raw Object → Typed KoiConfig

`validateKoiConfig(raw)` runs the Zod schema against the raw object.

```
  8 validated sections:
  ┌────────────────────────────────────────────────────┐
  │ logLevel       "debug"|"info"|"warn"|"error"|"silent" │
  │ telemetry      enabled, endpoint (URL), sampleRate    │
  │ limits         maxTurns, maxDurationMs, maxTokens     │
  │ loopDetection  enabled, windowSize, threshold         │
  │ spawn          maxDepth, maxFanOut, maxTotalProcesses  │
  │ forge          enabled, maxForgeDepth, defaultScope    │
  │ modelRouter    strategy, targets[]                     │
  │ features       Record<string, boolean>                 │
  └────────────────────────────────────────────────────┘
```

### 3. Resolution: Merge with Defaults

`resolveConfig(schema, defaults, raw)` validates then fills gaps with defaults.

```
  YOUR FILE                   DEFAULTS                 RESULT
  ┌──────────────┐           ┌──────────────┐         ┌──────────────┐
  │ maxTurns: 100│     +     │ maxTurns: 25 │    =    │ maxTurns: 100│  ← yours wins
  │              │           │ maxTokens:   │         │ maxTokens:   │
  │              │           │   100_000    │         │   100_000    │  ← default fills gap
  │ logLevel:    │           │ logLevel:    │         │ logLevel:    │
  │   "debug"    │           │   "info"     │         │   "debug"    │  ← yours wins
  └──────────────┘           └──────────────┘         └──────────────┘
```

### 4. Reactive Store: Subscribe to Changes

`createConfigStore(initial)` returns a frozen, observable store.

```
  store.get()         → frozen KoiConfig snapshot (O(1))
  store.set(next)     → freeze + notify all subscribers synchronously
  store.subscribe(fn) → fn(newConfig, oldConfig) on every set()
```

### 5. Slice Selection: Watch Only What You Need

`selectConfig(store, selector, listener)` fires only when the selected slice changes by reference.

```
  selectConfig(store, c => c.limits, (newLimits, oldLimits) => {
    // only called when limits object reference changes
    // NOT called when telemetry or features change
  })
```

### 6. ConfigManager: One Call Wires It All

`createConfigManager(options)` composes store + loader + reload + watcher.

```
  const mgr = createConfigManager({ filePath: "koi.yaml" });

  mgr.store          → ConfigStore<KoiConfig>  (read + subscribe)
  mgr.reload()       → re-read file, re-validate, update store
  mgr.watch()        → start fs.watch, auto-reload on change
```

---

## Defaults

`DEFAULT_KOI_CONFIG` provides sane defaults for all 8 sections:

```
logLevel:       "info"
telemetry:      { enabled: false }
limits:         { maxTurns: 25, maxDurationMs: 300_000, maxTokens: 100_000 }
loopDetection:  { enabled: true, windowSize: 8, threshold: 3 }
spawn:          { maxDepth: 3, maxFanOut: 5, maxTotalProcesses: 20 }
forge:          { enabled: true, maxForgeDepth: 1, maxForgesPerSession: 5,
                  defaultScope: "agent", defaultTrustTier: "sandbox" }
modelRouter:    { strategy: "fallback", targets: [{ provider: "default",
                  model: "default" }] }
features:       {}
```

---

## Security

### Sensitive Field Masking

`maskConfig(obj)` recursively redacts fields matching the `SENSITIVE_PATTERN` before logging:

```
  BEFORE                              AFTER
  ┌─────────────────────────┐        ┌─────────────────────────┐
  │ api_key: "sk-abc123"    │   →    │ api_key: "***"          │
  │ secret: "hunter2"       │   →    │ secret: "***"           │
  │ password: "letmein"     │   →    │ password: "***"         │
  │ logLevel: "info"        │   →    │ logLevel: "info"        │  ← safe, kept
  └─────────────────────────┘        └─────────────────────────┘

  Pattern: /(?:api[_-]?key|secret|password|token|credential|auth)/i
```

### Prototype Pollution Prevention

`deepMerge()` filters dangerous keys (`__proto__`, `constructor`, `prototype`) to prevent prototype pollution attacks from malicious config files.

---

## API Reference

### Loading

| Function | Returns | Purpose |
|----------|---------|---------|
| `loadConfig(filePath, options?)` | `Promise<Result<Record<string, unknown>, KoiError>>` | Read + parse + interpolate + include |
| `loadConfigFromString(content, filePath, options?)` | `Result<Record<string, unknown>, KoiError>` | Sync parse + interpolate (for testing) |
| `interpolateEnv(raw, env?)` | `string` | Replace `${VAR:-default}` patterns |

### Validation & Schema

| Function | Returns | Purpose |
|----------|---------|---------|
| `validateKoiConfig(raw)` | `Result<KoiConfig, KoiError>` | Zod-validate against all 8 sections |
| `getKoiConfigJsonSchema()` | `Record<string, unknown>` | Export Zod schema as JSON Schema (for IDEs) |
| `resolveConfig(schema, defaults, raw, prefix?)` | `Result<T, KoiError>` | Generic validate + merge with defaults |

### Reactive Store

| Function | Returns | Purpose |
|----------|---------|---------|
| `createConfigStore(initial)` | `WritableConfigStore<T>` | Frozen observable store |
| `selectConfig(store, selector, listener)` | `ConfigUnsubscribe` | Subscribe to a config slice with ref-equality |

### Manager

| Function | Returns | Purpose |
|----------|---------|---------|
| `createConfigManager(options)` | `ConfigManager` | One-call setup: store + reload + watch + event bus |

### Hot-reload primitives

| Function / value | Returns / type | Purpose |
|---|---|---|
| `diffConfig(prev, next)` | `readonly ChangedPath[]` | Structural diff between two config snapshots; dot-paths |
| `classifyChangedPaths(paths)` | `{ hot, restart }` | Split paths by `FIELD_CLASSIFICATION` (fail-closed) |
| `FIELD_CLASSIFICATION` | `Readonly<Record<string, ReloadClass>>` | Dot-path prefix → `"hot"` \| `"restart"` |
| `UNCLASSIFIED_SECTIONS` | `readonly string[]` | Allowlist of sections deliberately left unclassified |
| `createConfigEventBus()` | `ChangeNotifier<ConfigReloadEvent>` | Typed event bus factory |

### Bridge

| Function | Returns | Purpose |
|----------|---------|---------|
| `resolveKoiOptions(config)` | `ResolvedKoiOptions` | Map KoiConfig → engine-compatible options |

### Utilities

| Function | Returns | Purpose |
|----------|---------|---------|
| `deepMerge(base, override)` | `T` | Immutable recursive merge |
| `maskConfig(obj, pattern?)` | `Record<string, unknown>` | Redact sensitive fields |
| `processIncludes(parsed, parentPath, options?)` | `Promise<Result<Record<string, unknown>, KoiError>>` | Resolve `$include` directives |
| `watchConfigFile(options)` | `ConfigUnsubscribe` | Debounced file watcher |

### Constants

| Name | Value | Purpose |
|------|-------|---------|
| `DEFAULT_KOI_CONFIG` | `KoiConfig` | Sane defaults for all 8 sections |
| `SENSITIVE_PATTERN` | `RegExp` | Keys to redact in logs |

### Types

| Type | Description |
|------|-------------|
| `WritableConfigStore<T>` | ConfigStore with `set()` |
| `LoadConfigOptions` | Env + include options for loading |
| `ProcessIncludesOptions` | Max depth + env for `$include` |
| `ConfigManager` | High-level manager: store + reload + watch + events + registerConsumer |
| `CreateConfigManagerOptions` | Factory options for ConfigManager |
| `WatchConfigOptions` | File watcher configuration (now with optional `onError`) |
| `ResolvedKoiOptions` | Engine-compatible output from KoiConfig |
| `ChangedPath` | Dot-path string returned by `diffConfig` |
| `ReloadClass` | `"hot"` \| `"restart"` |
| `ClassifiedPaths` | `{ hot: readonly string[]; restart: readonly string[] }` |
| `ConfigChange` | `{ prev, next, changedPaths }` — payload for `ConfigConsumer` |
| `ConfigConsumer` | Single-method consumer contract (`onConfigChange`) |
| `ConfigReloadEvent` | Discriminated union: `attempted` \| `applied` \| `rejected` \| `changed` |
| `ConfigRejectReason` | `"load"` \| `"validation"` \| `"restart-required"` |

---

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| `Result<T, KoiError>` return type everywhere | Never throws for expected failures; callers handle errors explicitly |
| `Object.freeze()` on every `set()` | Prevents accidental mutation of shared config snapshots |
| Synchronous subscriber notification | Predictable ordering; listeners see new config before next `get()` |
| Ref-equality in `selectConfig()` | Avoids deep-equal cost; immutable store guarantees new reference = new value |
| `$include` with cycle detection | Composable configs without infinite loops; diamond graphs intentionally allowed |
| Env interpolation before parsing | `${VAR}` works in both YAML and JSON; one code path for both formats |
| Debounced file watcher | Editors trigger multiple write events on save; debouncing coalesces them |
| `maskConfig()` with configurable pattern | Safe logging by default; custom patterns for domain-specific secrets |
| Prototype pollution guard in `deepMerge()` | Config files are external input; untrusted YAML could inject `__proto__` |

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────────┐
    KoiConfig, ConfigStore<T>, ConfigListener, Result<T,E>   │
    (types only — zero logic)                                 │
                                                              │
L0u @koi/validation ──────────────────┐                      │
    validateWith()                    │                      │
                                      ▼                      ▼
L0u @koi/config ◄────────────────────┴──────────────────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ one external dep: zod
```

**Dev-only:** `@koi/test-utils` used in tests but not a runtime import.
