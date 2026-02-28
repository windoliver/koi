# @koi/registry-store — Agent-Facing Registry Tools

An L2 `ComponentProvider` that wraps `BrickRegistryReader`, `SkillRegistryReader`, and `VersionIndexReader` into 4 agent-facing tools. Agents can search bricks via FTS5, inspect details, list versions, and install capabilities — turning the SQLite registry into a self-serve package manager.

---

## Why It Exists

`@koi/registry-store` implements 3 SQLite-backed registries (BrickRegistry, SkillRegistry, VersionIndex) with FTS5 full-text search. But without agent-facing tools, this data is only accessible programmatically. It's like having npm but no `npm search` or `npm install` commands.

`createRegistryProvider` solves this by providing a `ComponentProvider` that:

- **Exposes 4 validated tools** — LLM-safe JSON schemas with input parsing and error handling
- **Attaches the REGISTRY token** — agents can access `RegistryComponent` via ECS
- **Separates trust tiers** — read tools are `verified`, install is `promoted`
- **Injects an onInstall callback** — host decides what "install" means (forge, hot-load, log)
- **Includes a skill guide** — teaches the agent when to search vs browse, how to evaluate trust

---

## What This Enables

### Before vs After

```
WITHOUT REGISTRY TOOLS                    WITH REGISTRY TOOLS
──────────────────────                    ───────────────────

Agent:                                    Agent manifest:
  "I need a PII redaction                   providers:
   middleware, but I can't                    - registry
   look anything up..."
                                          LLM tool calls:
Host must pre-wire                          registry_search({
every capability at                           text: "pii",
assembly time.                                kind: "middleware"
                                            })
No runtime discovery.
No self-extension.                          registry_get({
                                              kind: "middleware",
                                              name: "pii-redact",
                                              detail: "full"
                                            })

                                            registry_install({
                                              kind: "middleware",
                                              name: "pii-redact"
                                            })

                                          Agent now has pii-redact
                                          middleware (hot-loaded).
```

### Self-Extending Agent Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                     MINIMAL AGENT                                │
│                                                                  │
│  Starts with only 4 registry tools.                              │
│  Grows capabilities on demand.                                   │
│                                                                  │
│  User: "Read file X and redact PII from the output"             │
│                                                                  │
│  Turn 1: registry_search                                         │
│    └─ text: "filesystem"                                         │
│         └─ items: [{ name: "filesystem-tools", kind: "tool" }]   │
│                                                                  │
│  Turn 2: registry_install                                        │
│    └─ kind: "tool", name: "filesystem-tools"                     │
│         └─ onInstall → forge → hot-attach                        │
│         └─ { installed: true }                                   │
│                                                                  │
│  Turn 3: registry_search                                         │
│    └─ text: "pii", kind: "middleware"                            │
│         └─ items: [{ name: "pii-redact", trustTier: "verified" }]│
│                                                                  │
│  Turn 4: registry_install                                        │
│    └─ kind: "middleware", name: "pii-redact"                     │
│         └─ onInstall → forge → hot-attach                        │
│         └─ { installed: true }                                   │
│                                                                  │
│  Turn 5: filesystem_read + PII middleware active                 │
│    └─ Agent reads file, output is auto-redacted                  │
│                                                                  │
│  Agent grew from 4 tools → 9+ tools mid-conversation.           │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture

### Layer Position

```
L0   @koi/core                ─ BrickRegistryReader, SkillRegistryReader,
                                 VersionIndexReader, RegistryComponent,
                                 REGISTRY token, BrickArtifact, BrickKind
L0u  @koi/sqlite-utils        ─ SQLite helper utilities
L2   @koi/registry-store      ─ this package (3 SQLite registries +
                                 ComponentProvider + 4 tools + 1 skill)
```

Imports from `@koi/core` (L0) and `@koi/sqlite-utils` (L0u) only. Never touches `@koi/engine` (L1) or peer L2 packages at runtime.

### Internal Module Map

```
index.ts                               ← public re-exports
│
├── brick-registry.ts                  ← createSqliteBrickRegistry() — FTS5 search
├── skill-registry.ts                  ← createSqliteSkillRegistry() — skill publish/install
├── version-index.ts                   ← createSqliteVersionIndex() — semver resolution
│
├── registry-component-provider.ts     ← createRegistryProvider() factory
├── registry-skill.ts                  ← skill:registry-guide (agent guidance)
├── parse-args.ts                      ← safe LLM input parsing
│
└── tools/
    ├── map-brick.ts                   ← shared BrickArtifact → JsonObject projections
    ├── registry-search.ts    + .test  ← FTS5 search across bricks
    ├── registry-get.ts       + .test  ← get brick details (summary/full)
    ├── registry-list-versions.ts + .test ← list version history
    ├── registry-install.ts   + .test  ← install a brick (skill or non-skill)
    └── test-helpers.ts                ← mock factories for unit tests
```

### Relationship to Other Discovery Packages

```
┌─────────────────────────────────────────────────────────────────┐
│                     CAPABILITY DISCOVERY                         │
│                                                                  │
│  @koi/catalog                  @koi/registry-store               │
│  ─────────────                 ────────────────────              │
│  High-level unified            Low-level registry-specific       │
│  discovery across 4 sources    FTS5 search + version listing     │
│  (bundled, forge, MCP, etc.)   + trust tier + install callback   │
│                                                                  │
│  search_catalog                registry_search                   │
│  attach_capability             registry_get                      │
│                                registry_list_versions             │
│                                registry_install                   │
│                                                                  │
│  Complementary — catalog is    Registry is the backend that      │
│  the unified frontend.         catalog adapters query.            │
└─────────────────────────────────────────────────────────────────┘
```

---

## The 4 Tools

| # | Tool Name | Trust Tier | Input | Output |
|---|-----------|-----------|-------|--------|
| 1 | `registry_search` | verified | `text?`, `kind?`, `tags?`, `limit?`, `cursor?` | `{ items, cursor?, total? }` |
| 2 | `registry_get` | verified | `kind`, `name`, `detail?` | BrickSummary or BrickFull |
| 3 | `registry_list_versions` | verified | `kind`, `name` | `{ versions, count }` |
| 4 | `registry_install` | promoted | `kind`, `name`, `version?` | `{ installed, artifact }` |

### Tool Input Details

**`registry_search`** — FTS5 full-text search across bricks

- `text` (string): FTS5 search query. Omit to browse all bricks
- `kind` (string): Filter by brick kind (`tool`, `skill`, `agent`, `middleware`, `channel`)
- `tags` (string[]): Filter by tags (AND — all must match)
- `limit` (number): Max results per page. Default: 20, max: 50
- `cursor` (string): Opaque cursor for next page

**`registry_get`** — Get detailed info about a single brick

- `kind` (string, required): Brick kind
- `name` (string, required): Brick name
- `detail` (string): `"summary"` (default) omits implementation; `"full"` includes everything

**`registry_list_versions`** — List version history for a brick

- `kind` (string, required): Brick kind
- `name` (string, required): Brick name

**`registry_install`** — Install a brick from the registry

- `kind` (string, required): Brick kind
- `name` (string, required): Brick name
- `version` (string): Specific version. Omit for latest

### Response Projections

The tools return different levels of detail to manage context window usage:

```
BrickSummary (search, get default)       BrickFull (get detail="full")
──────────────────────────────────       ─────────────────────────────
id                                       id
kind                                     kind
name                                     name
description                              description
version                                  version
tags                                     tags
trustTier                                trustTier
lifecycle                                lifecycle
scope                                    scope
usageCount                               usageCount
requires?                                requires?
                                         files?
                                         configSchema?
                                         implementation      ← kind-specific
                                         inputSchema         ← kind-specific
                                         testCases?          ← kind-specific
                                         content             ← skill only
                                         manifestYaml        ← agent only

BrickInstallSummary (install result)
────────────────────────────────────
id, kind, name, description, version,
tags, trustTier, lifecycle, scope
(omits usageCount — not relevant post-install)
```

---

## Trust Tiers

```
  registry_search         ── verified   (read-only, no side effects)
  registry_get            ── verified   (read-only, no side effects)
  registry_list_versions  ── verified   (read-only, no side effects)
  registry_install        ── promoted   (modifies agent capabilities)

  The split is deliberate:
  ├─ Read tools are "verified" — agent can freely browse the registry
  └─ Install is "promoted" — installing a brick changes what the agent
     can do, so it requires elevated trust
```

The `customTools` hook in `createServiceProvider` handles this split — the 3 read tools use the standard factory pattern at the configured trust tier, while `registry_install` is injected separately at `"promoted"`.

---

## Install Semantics — onInstall Callback

The `registry_install` tool doesn't know what "install" means. The host decides via dependency injection:

```
                registry_install
                       │
                       ├─ kind === "skill"?
                       │    yes → facade.skills.install(id, version)
                       │    no  → facade.bricks.get(kind, name)
                       │
                       ▼
                  artifact fetched
                       │
                       ├─ onInstall provided?
                       │    yes → onInstall(artifact) → { installed: true }
                       │    no  → { installed: false, message: "download-only" }
                       │
                       ▼
                  returns summary
```

**Typical onInstall implementations:**

| Host | What onInstall does |
|------|---------------------|
| ForgeStore integration | `forgeStore.add(artifact)` → hot-attaches to running agent |
| CLI tool | Writes artifact to local `.koi/bricks/` directory |
| Audit-only | Logs the install event, returns ok without side effects |
| Test harness | Collects artifacts in an array for assertions |

---

## Skill Component — `registry-guide`

The provider attaches a `SkillComponent` at `skillToken("registry-guide")` with guidance for the agent:

- **When to search vs browse** — use `text` for keyword search, omit for browsing by kind/tags
- **Trust tier evaluation** — check `trustTier` before installing (sandbox → safe for experimentation, verified → production-ready, promoted → first-party)
- **Version selection** — use `registry_list_versions` before installing, prefer latest non-deprecated

---

## API Reference

### Factory

#### `createRegistryProvider(config)`

Creates a `ComponentProvider` that attaches 4 registry tools + 1 skill to agents.

```typescript
import { createRegistryProvider } from "@koi/registry-store";
```

### RegistryProviderConfig

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `bricks` | `BrickRegistryReader` | required | Brick registry backend |
| `skills` | `SkillRegistryReader` | required | Skill registry backend |
| `versions` | `VersionIndexReader` | required | Version index backend |
| `trustTier` | `TrustTier` | `"verified"` | Trust level for read tools |
| `prefix` | `string` | `"registry"` | Tool name prefix (e.g., `"registry"` → `registry_search`) |
| `priority` | `number` | — | Assembly priority for the provider |
| `onInstall` | `OnInstallCallback` | — | Callback invoked on `registry_install`. Omit for download-only mode |

### OnInstallCallback

```typescript
type OnInstallCallback = (artifact: BrickArtifact) => Promise<Result<void, KoiError>>;
```

### L0 Types (in `@koi/core`)

```typescript
// Singleton token — access the registry backend on an agent entity
import { REGISTRY } from "@koi/core";
const reg = agent.component<RegistryComponent>(REGISTRY);

// RegistryComponent — the backend triple
interface RegistryComponent {
  readonly bricks: BrickRegistryReader;
  readonly skills: SkillRegistryReader;
  readonly versions: VersionIndexReader;
}
```

---

## Examples

### 1. Minimal Setup (read-only, no install)

```typescript
import { createRegistryProvider } from "@koi/registry-store";
import { createKoi } from "@koi/engine";

const provider = createRegistryProvider({
  bricks: brickRegistry,
  skills: skillRegistry,
  versions: versionIndex,
  // No onInstall → install tool returns artifact data without side effects
});

const runtime = await createKoi({
  manifest: { name: "browser-agent", version: "1.0.0", model: { name: "claude-haiku" } },
  adapter,
  providers: [provider],
});
```

### 2. Full Setup with ForgeStore Integration

```typescript
import { createRegistryProvider } from "@koi/registry-store";

const provider = createRegistryProvider({
  bricks: brickRegistry,
  skills: skillRegistry,
  versions: versionIndex,
  onInstall: async (artifact) => {
    // Hot-load the artifact into the running agent via ForgeStore
    const result = await forgeStore.add(artifact);
    if (!result.ok) return result;
    return { ok: true, value: undefined };
  },
});
```

### 3. Custom Prefix (multi-registry setup)

```typescript
// Primary registry
const primaryProvider = createRegistryProvider({
  bricks: primaryBricks,
  skills: primarySkills,
  versions: primaryVersions,
  prefix: "primary",  // → primary_search, primary_get, etc.
});

// Community registry
const communityProvider = createRegistryProvider({
  bricks: communityBricks,
  skills: communitySkills,
  versions: communityVersions,
  prefix: "community",  // → community_search, community_get, etc.
});
```

### 4. Accessing RegistryComponent via ECS

```typescript
import { REGISTRY } from "@koi/core";
import type { RegistryComponent } from "@koi/core";

// In middleware or other component code:
const registry = agent.component<RegistryComponent>(REGISTRY);
const page = await registry.bricks.search({ text: "pii" });
```

---

## Testing

### Unit Tests (51 tests, mocked backends)

```
bun test --cwd packages/registry-store
```

Tests per file:

| File | Tests | Coverage |
|------|-------|----------|
| `parse-args.test.ts` | 20 | All parsers + edge cases |
| `registry-search.test.ts` | 7 | FTS5 queries, pagination, tag filtering |
| `registry-get.test.ts` | 5 | Summary/full modes, not-found, validation |
| `registry-list-versions.test.ts` | 5 | Version listing, deprecated flags |
| `registry-install.test.ts` | 5 | Skill/non-skill paths, callback, download-only |
| `registry-provider.test.ts` | 9 | Integration: real SQLite, full provider assembly |

### E2E Tests (6 tests, real Anthropic API)

```
E2E_TESTS=1 bun --env-file=../../.env test src/__tests__/e2e-registry-tools
```

| Test | What it proves |
|------|----------------|
| Tool discovery | All 4 tools + skill registered on agent entity |
| `registry_search` | LLM searches by text, finds correct brick |
| `registry_get` | LLM gets full detail including implementation |
| `registry_list_versions` | LLM lists versions with deprecated flags |
| `registry_install` | LLM installs skill, onInstall callback fires |
| Full pipeline | Search → install with middleware observer verifying chain |

---

## Layer Compliance

```
  ┌─────────────────────────────────────────────────────┐
  │  L0  @koi/core                                      │
  │  ┌───────────────────────────────────────────────┐  │
  │  │  RegistryComponent (interface)                │  │
  │  │  REGISTRY (SubsystemToken)                    │  │
  │  │  BrickRegistryReader, SkillRegistryReader,    │  │
  │  │  VersionIndexReader (interfaces)              │  │
  │  │  BrickArtifact, BrickKind, JsonObject (types) │  │
  │  │  createServiceProvider (factory)              │  │
  │  │  toolToken, skillToken (branded constructors)  │  │
  │  └───────────────────────────────────────────────┘  │
  │         ▲                                           │
  │         │ import type / import                      │
  │         │                                           │
  │  ┌──────┴────────────────────────────────────────┐  │
  │  │  L0u @koi/sqlite-utils                        │  │
  │  │  (SQLite helpers for registry implementations) │  │
  │  └───────────────────────────────────────────────┘  │
  │         ▲                                           │
  │         │ import                                    │
  │         │                                           │
  │  ┌──────┴────────────────────────────────────────┐  │
  │  │  L2  @koi/registry-store  ← this package      │  │
  │  │                                                │  │
  │  │  3 SQLite registries (Brick, Skill, Version)   │  │
  │  │  4 agent-facing tools (search, get, versions,  │  │
  │  │    install)                                    │  │
  │  │  1 skill component (registry-guide)            │  │
  │  │  1 ComponentProvider (createRegistryProvider)   │  │
  │  └───────────────────────────────────────────────┘  │
  │                                                     │
  │  ✗ No import from @koi/engine (L1)                  │
  │  ✗ No import from peer L2 packages                  │
  │  ✗ No vendor types                                  │
  └─────────────────────────────────────────────────────┘
```

---

## Related

- **Issue**: [#535](https://github.com/windoliver/koi/issues/535) — feat: add ComponentProvider + agent-facing tools to @koi/registry-store
- **@koi/catalog** — High-level unified discovery (search_catalog, attach_capability)
- **@koi/forge** — Self-extension runtime (create, verify, sign bricks)
- **@koi/scheduler-provider** — Same pattern (ComponentProvider wrapping a backend into tools)
- **`docs/service-provider.md`** — `createServiceProvider` factory documentation
