# @koi/bundle — Portable Agent Export/Import

Docker-style `export` / `import` for Koi agents. Packages an agent's manifest + all forged bricks (tools, skills, middleware, channels) into a single `.koibundle` JSON file. Import into another deployment with SHA-256 integrity verification, content-addressed deduplication, and automatic trust downgrading.

---

## Why It Exists

Koi agents are composed of a manifest plus forged bricks — tools, skills, middleware, channels — each content-addressed by SHA-256. Today there's no portable packaging: if you forge an agent in dev and want to run it in staging, you manually copy bricks and hope nothing is missing or corrupted.

`@koi/bundle` solves this by providing a single-file portable artifact that:

- Contains everything needed to reconstruct an agent's brick set
- Verifies integrity at every level (bundle hash + per-brick hash)
- Prevents accidental duplication via content-addressed dedup
- Enforces security boundaries by downgrading trust on import

---

## What This Enables

### Before vs After

```
WITHOUT BUNDLE                              WITH BUNDLE
──────────────                              ───────────

Dev environment:                            Dev environment:
  "I forged 5 tools for the                   createBundle() → sales.koibundle
   sales agent. Let me copy                     (single JSON file, integrity-sealed)
   them one by one to staging..."
                                                    │
  ┌─ manual copy ─┐                                 │  email / S3 / git / USB
  │  tool-1.json   │                                │
  │  tool-2.json   │  ← error-prone                 ▼
  │  tool-3.json   │  ← no integrity check
  │  oops-forgot-4 │  ← missing brick!         Staging environment:
  │  tool-5.json   │                              importBundle() → 5 bricks imported
  └────────────────┘                                ✓ integrity verified
                                                    ✓ duplicates skipped
Staging:                                            ✓ trust downgraded to sandbox
  "Why is tool 4 missing?"                          ✓ provenance rewritten
  "Did tool 3 get corrupted?"
  "These are running as verified?!"
```

### Full Lifecycle

```
┌─────────────────────────────────────────────────────────────────┐
│                     DEPLOYMENT A (Dev)                          │
│                                                                 │
│  ┌──────────────┐    ┌──────────────────────────────────────┐   │
│  │  Agent YAML   │    │           ForgeStore A               │   │
│  │               │    │                                      │   │
│  │  name: sales  │    │  ┌─────────┐ ┌─────────┐ ┌────────┐ │   │
│  │  model: ...   │    │  │ tool:   │ │ tool:   │ │ skill: │ │   │
│  │  tools:       │    │  │ search  │ │ draft   │ │ close  │ │   │
│  │   - search    │    │  │ sha256: │ │ sha256: │ │ sha256:│ │   │
│  │   - draft     │    │  │ a1b2c3  │ │ d4e5f6  │ │ 789abc │ │   │
│  │   - close     │    │  │ trust:  │ │ trust:  │ │ trust: │ │   │
│  │               │    │  │ verified│ │ verified│ │verified│ │   │
│  └──────┬───────┘    │  └─────────┘ └─────────┘ └────────┘ │   │
│         │            └──────────────┬───────────────────────┘   │
│         └───────────┬───────────────┘                           │
│                     ▼                                           │
│            ┌────────────────┐                                   │
│            │ createBundle() │  gather manifest + bricks         │
│            └───────┬────────┘                                   │
│                    ▼                                            │
│         ┌──────────────────────┐                                │
│         │ serializeBundle()    │  → JSON string                 │
│         └──────────┬───────────┘                                │
└────────────────────┼────────────────────────────────────────────┘
                     │
                     ▼
          ┌──────────────────────────┐
          │  sales-agent.koibundle   │
          │                          │
          │  {                       │
          │   version: "1",          │
          │   id: "bundle:sha...",   │
          │   name: "sales-agent",   │
          │   manifestYaml: "...",   │
          │   bricks: [ ... ],       │
          │   contentHash: "abc..."  │
          │  }                       │
          └────────────┬─────────────┘
                       │
           ────────────┼──────────────
             file transfer / network
           ────────────┼──────────────
                       │
┌──────────────────────┼──────────────────────────────────────────┐
│                      ▼              DEPLOYMENT B (Staging)      │
│          ┌───────────────────────┐                              │
│          │ deserializeBundle()   │  ← parse + validate JSON     │
│          └───────────┬───────────┘                              │
│                      ▼                                          │
│             ┌────────────────┐                                  │
│             │ importBundle() │  ← verify + dedup + downgrade    │
│             └───────┬────────┘                                  │
│                     ▼                                           │
│   ┌──────────────────────────────────────┐                      │
│   │           ForgeStore B               │                      │
│   │                                      │                      │
│   │  ┌─────────┐ ┌─────────┐ ┌────────┐ │                      │
│   │  │ tool:   │ │ tool:   │ │ skill: │ │                      │
│   │  │ search  │ │ draft   │ │ close  │ │  Same content,       │
│   │  │ sha256: │ │ sha256: │ │ sha256:│ │  different trust     │
│   │  │ a1b2c3  │ │ d4e5f6  │ │ 789abc │ │                      │
│   │  │ trust:  │ │ trust:  │ │ trust: │ │                      │
│   │  │ SANDBOX │ │ SANDBOX │ │SANDBOX │ │◄── not "verified"    │
│   │  │ origin: │ │ origin: │ │origin: │ │                      │
│   │  │ bundled │ │ bundled │ │bundled │ │◄── not "forged"      │
│   │  └─────────┘ └─────────┘ └────────┘ │                      │
│   └──────────────────┬───────────────────┘                      │
│                      ▼                                          │
│              ┌──────────────┐                                   │
│              │  createKoi() │  Wire into live agent runtime     │
│              │  + adapter   │                                   │
│              └──────────────┘                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Architecture

`@koi/bundle` is an **L2 feature package** — it depends only on `@koi/core` (L0), `@koi/hash` (L0u), and `@koi/validation` (L0u).

```
┌───────────────────────────────────────────────────────┐
│  @koi/bundle  (L2)                                    │
│                                                       │
│  types.ts            ← config types, result types      │
│  brick-content.ts    ← extract primary content string  │
│  export-bundle.ts    ← createBundle()                  │
│  import-bundle.ts    ← importBundle()                  │
│  serialize.ts        ← serializeBundle/deserialize     │
│  index.ts            ← public API surface              │
│                                                       │
├───────────────────────────────────────────────────────┤
│  Dependencies                                         │
│                                                       │
│  @koi/core        (L0)   AgentBundle, BundleId,       │
│                           BrickArtifact, ForgeStore,   │
│                           Result, KoiError             │
│  @koi/hash        (L0u)  computeBrickId(),            │
│                           computeContentHash()         │
│  @koi/validation  (L0u)  validateBrickArtifact()      │
└───────────────────────────────────────────────────────┘
```

### L0 Types (in `@koi/core`)

The bundle envelope and branded ID live in L0 so any package can reference them:

```typescript
// Branded type — prevents mixing with other ID types
type BundleId = string & { readonly [__bundleIdBrand]: "BundleId" };
function bundleId(raw: string): BundleId;

// Version constant
const BUNDLE_FORMAT_VERSION = "1" as const;

// The portable artifact envelope
interface AgentBundle {
  readonly version: typeof BUNDLE_FORMAT_VERSION;
  readonly id: BundleId;
  readonly name: string;
  readonly description: string;
  readonly manifestYaml: string;
  readonly bricks: readonly BrickArtifact[];
  readonly contentHash: string;
  readonly createdAt: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
```

---

## Export Pipeline

```
createBundle(config)
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  1. Validate inputs                                     │
│     name ≠ empty, manifestYaml ≠ empty, brickIds ≠ []   │
│     Fail → VALIDATION error                             │
│                                                         │
│  2. Deduplicate brick IDs                               │
│     [a, b, a, c] → Set → [a, b, c]                     │
│                                                         │
│  3. Parallel load from ForgeStore                       │
│     Promise.all(ids.map(id => store.load(id)))          │
│     Missing? → NOT_FOUND error listing missing IDs      │
│                                                         │
│  4. Verify integrity of each brick                      │
│     recompute BrickId from content via computeBrickId() │
│     Mismatch? → VALIDATION error                        │
│                                                         │
│  5. Compute bundle content hash                         │
│     computeContentHash({                                │
│       manifest: manifestYaml,                           │
│       brickIds: sorted                                  │
│     })                                                  │
│                                                         │
│  6. Return AgentBundle envelope                         │
│     id = bundleId(`bundle:${contentHash}`)              │
└─────────────────────────────────────────────────────────┘
  │
  ▼
Result<AgentBundle, KoiError>
```

### Content Hash

The bundle's `contentHash` is deterministic — same manifest + same brick IDs (sorted) always produces the same hash. This enables tamper detection on import.

```
contentHash = computeContentHash({
  manifest: "name: sales-agent\nversion: 1.0",
  brickIds: ["sha256:111...", "sha256:222...", "sha256:333..."]  ← sorted
})
```

---

## Import Pipeline

```
importBundle(config)
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│  1. Validate bundle version                             │
│     bundle.version === BUNDLE_FORMAT_VERSION ("1")      │
│     Wrong? → VALIDATION error                           │
│                                                         │
│  2. Verify bundle content hash                          │
│     Recompute from manifest + sorted brick IDs          │
│     Mismatch? → VALIDATION error (tamper detected)      │
│                                                         │
│  3. For each brick (in parallel):                       │
│     ┌─────────────────────────────────────────────┐     │
│     │ a. Validate structure (validateBrickArtifact)│     │
│     │    Invalid? → error for this brick           │     │
│     │                                              │     │
│     │ b. Verify integrity (recompute BrickId)      │     │
│     │    Hash mismatch? → error for this brick     │     │
│     │                                              │     │
│     │ c. Dedup check (store.exists(brick.id))      │     │
│     │    Already exists? → skip                    │     │
│     │                                              │     │
│     │ d. Downgrade trust + save                    │     │
│     │    trustTier: "verified" → "sandbox"         │     │
│     │    scope: → "agent"                          │     │
│     │    provenance.source: → "bundled"            │     │
│     │    store.save(downgraded)                    │     │
│     └─────────────────────────────────────────────┘     │
│                                                         │
│  4. Return { imported, skipped, errors }                │
└─────────────────────────────────────────────────────────┘
  │
  ▼
Result<ImportBundleResult, KoiError>
```

### Trust Downgrade

Every imported brick is downgraded — no exceptions. Imported code runs in sandbox until explicitly promoted.

```
BEFORE IMPORT (origin store)              AFTER IMPORT (destination store)
────────────────────────                  ──────────────────────────────

trustTier: "verified"                     trustTier: "sandbox"
scope:     "system"                       scope:     "agent"
provenance.source:                        provenance.source:
  { origin: "forged",                       { origin: "bundled",
    forgedBy: "dev-agent" }                   bundleName: "sales-agent",
                                              bundleVersion: "1" }
```

### Deduplication

Bricks are content-addressed — same code always produces the same SHA-256 ID. If a brick with the same ID already exists in the destination store, it's skipped.

```
Import #1:  3 bricks → imported: 3, skipped: 0  ✓
Import #2:  3 bricks → imported: 0, skipped: 3  (same SHA-256 IDs)
Import #3:  4 bricks → imported: 1, skipped: 3  (1 new brick)
```

### Tamper Detection

If an attacker modifies the `.koibundle` file (e.g., changes the manifest or swaps a brick), import detects it at two levels:

```
Level 1 — Bundle content hash:

  Attacker changes manifestYaml in .koibundle
           │
           ▼
  importBundle() recomputes contentHash from manifest + brick IDs
           │
           ▼
  expected: "abc123..."  got: "xyz789..."  → VALIDATION ERROR

Level 2 — Per-brick integrity:

  Attacker changes brick implementation but keeps original ID
           │
           ▼
  importBundle() recomputes BrickId from brick content
           │
           ▼
  expected: "sha256:aaa..."  got: "sha256:bbb..."  → brick-level error
```

---

## Serialization

```
serializeBundle(bundle)    JSON.stringify(bundle, null, 2)  → human-readable JSON
deserializeBundle(json)    JSON.parse + field-by-field validation → Result<AgentBundle>
```

`deserializeBundle` validates every field before returning:

```
Raw JSON string
  │
  ▼
┌──────────────────────────────────────────────────┐
│  1. JSON.parse()                                 │
│     Invalid JSON? → VALIDATION error             │
│                                                  │
│  2. Field-by-field checks:                       │
│     version:      string, matches FORMAT_VERSION │
│     id:           non-empty string               │
│     name:         non-empty string               │
│     description:  non-empty string               │
│     manifestYaml: non-empty string               │
│     contentHash:  non-empty string               │
│     createdAt:    number                         │
│     bricks:       array                          │
│     metadata:     object or undefined            │
│                                                  │
│  3. Deep validation of each brick                │
│     validateBrickArtifact() from @koi/validation │
│                                                  │
│  Fail at any step → VALIDATION error with detail │
└──────────────────────────────────────────────────┘
  │
  ▼
Result<AgentBundle, KoiError>
```

---

## Examples

### Export an Agent's Bricks

```typescript
import { createBundle, serializeBundle } from "@koi/bundle";
import type { ForgeStore } from "@koi/core";

// store: ForgeStore — your existing brick storage
// brickIds: string[] — the IDs of bricks to include

const result = await createBundle({
  name: "sales-agent",
  description: "Sales agent with CRM tools",
  manifestYaml: "name: sales-agent\nversion: 1.0\nmodel: claude-sonnet-4-5",
  brickIds: ["sha256:aaa...", "sha256:bbb...", "sha256:ccc..."],
  store,
  metadata: { exportedBy: "admin", environment: "dev" },
});

if (result.ok) {
  const json = serializeBundle(result.value);
  // Write json to sales-agent.koibundle file
  await Bun.write("sales-agent.koibundle", json);
}
```

### Import into Another Deployment

```typescript
import { deserializeBundle, importBundle } from "@koi/bundle";
import type { ForgeStore } from "@koi/core";

// Read the .koibundle file
const json = await Bun.file("sales-agent.koibundle").text();

// Deserialize with validation
const parsed = deserializeBundle(json);
if (!parsed.ok) {
  console.error("Invalid bundle:", parsed.error.message);
  return;
}

// Import into destination store
const result = await importBundle({
  bundle: parsed.value,
  store: destinationStore,
});

if (result.ok) {
  console.log(`Imported: ${result.value.imported}`);
  console.log(`Skipped (dedup): ${result.value.skipped}`);
  console.log(`Errors: ${result.value.errors.length}`);
  for (const err of result.value.errors) {
    console.error(`  Brick ${err.brickId}: ${err.reason}`);
  }
}
```

### Wire Imported Bricks into a Live Agent

```typescript
import { importBundle, deserializeBundle } from "@koi/bundle";
import { createKoi } from "@koi/engine";
import { createPiAdapter } from "@koi/engine-pi";
import type { ForgeStore, ComponentProvider, Tool } from "@koi/core";
import { toolToken } from "@koi/core";

// 1. Import bundle into store
const json = await Bun.file("sales-agent.koibundle").text();
const bundle = deserializeBundle(json);
if (!bundle.ok) throw new Error(bundle.error.message);

const store: ForgeStore = /* your store */;
await importBundle({ bundle: bundle.value, store });

// 2. Create a ComponentProvider that resolves tools from the store
const toolProvider: ComponentProvider = {
  name: "bundle-tool-provider",
  attach: async () => {
    const result = await store.search({ kind: "tool" });
    if (!result.ok) return new Map();

    const entries: Array<[string, Tool]> = [];
    for (const brick of result.value) {
      if (brick.kind !== "tool") continue;
      entries.push([
        toolToken(brick.name) as string,
        {
          descriptor: {
            name: brick.name,
            description: brick.description,
            inputSchema: brick.inputSchema,
          },
          trustTier: brick.trustTier,   // "sandbox" after import
          execute: async (input) => {
            // Your sandbox executor here
            return "result";
          },
        },
      ]);
    }
    return new Map(entries);
  },
};

// 3. Wire into Koi runtime
const runtime = await createKoi({
  manifest: { name: "Sales Agent", version: "1.0.0", model: { name: "claude-sonnet-4-5" } },
  adapter: createPiAdapter({
    model: "anthropic:claude-sonnet-4-5",
    getApiKey: async () => process.env.ANTHROPIC_API_KEY!,
  }),
  providers: [toolProvider],
});

// 4. Run the agent — imported tools are available
for await (const event of runtime.run({ kind: "text", text: "Search CRM for leads" })) {
  if (event.kind === "text_delta") process.stdout.write(event.delta);
}
```

---

## Bundle File Format

A `.koibundle` file is pretty-printed JSON:

```json
{
  "version": "1",
  "id": "bundle:sha256:a1b2c3d4e5f6...",
  "name": "sales-agent",
  "description": "Sales agent with CRM tools",
  "manifestYaml": "name: sales-agent\nversion: 1.0\nmodel: claude-sonnet-4-5",
  "bricks": [
    {
      "id": "sha256:aaa111...",
      "kind": "tool",
      "name": "search_crm",
      "description": "Search CRM for customer records",
      "implementation": "async function search(input) { ... }",
      "inputSchema": { "type": "object", "properties": { "query": { "type": "string" } } },
      "trustTier": "verified",
      "scope": "agent",
      "lifecycle": "active",
      "provenance": { "..." : "..." },
      "version": "1.0.0",
      "tags": ["crm"],
      "usageCount": 42
    }
  ],
  "contentHash": "sha256:deadbeef...",
  "createdAt": 1709000000000,
  "metadata": {
    "exportedBy": "admin",
    "environment": "dev"
  }
}
```

---

## API Reference

### Core Functions

| Function | Returns | Purpose |
|----------|---------|---------|
| `createBundle(config)` | `Promise<Result<AgentBundle, KoiError>>` | Export bricks from store into bundle |
| `importBundle(config)` | `Promise<Result<ImportBundleResult, KoiError>>` | Import bundle into store with dedup + downgrade |
| `serializeBundle(bundle)` | `string` | Bundle → JSON string |
| `deserializeBundle(json)` | `Result<AgentBundle, KoiError>` | JSON string → validated bundle |

### Config Types

| Type | Purpose |
|------|---------|
| `ExportBundleConfig` | Input to `createBundle()` — name, description, manifest, brick IDs, store |
| `ImportBundleConfig` | Input to `importBundle()` — bundle, store |
| `ImportBundleResult` | Output of `importBundle()` — imported/skipped/errors counts |
| `ImportBrickError` | Per-brick error detail — brickId + reason |

### Error Cases

| Error Code | When | Example |
|------------|------|---------|
| `VALIDATION` | Empty name, bad version, tampered hash, invalid brick | `"Bundle content hash mismatch"` |
| `NOT_FOUND` | Brick ID not found in source store | `"Bricks not found: sha256:abc..."` |

---

## Layer Compliance

```
L0  @koi/core ─────────────────────────────────────────┐
    AgentBundle, BundleId, BrickArtifact,               │
    ForgeStore, Result<T,E>, KoiError — types only       │
                                                        │
L0u @koi/hash ─────────────────────────────┐           │
    computeBrickId(), computeContentHash() │           │
                                           │           │
L0u @koi/validation ───────────────┐       │           │
    validateBrickArtifact()        │       │           │
                                   ▼       ▼           ▼
L2  @koi/bundle ◄──────────────────┴───────┴───────────┘
    imports from L0 + L0u only
    ✗ never imports @koi/engine (L1)
    ✗ never imports peer L2 packages
    ✓ zero external dependencies
```

**Dev-only:** `@koi/engine`, `@koi/engine-pi`, `@koi/forge`, `@koi/test-utils` used in E2E tests but not runtime imports.
