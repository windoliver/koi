# Companion Skills

How brick descriptors teach the LLM when and how to use them.

## Overview

Every L2 package exports a `BrickDescriptor` — a factory that creates runtime instances from manifest config. Companion skills let descriptors bundle teaching prompts that get auto-registered into ForgeStore during agent startup. The LLM can then discover these skills to make informed decisions about which bricks to enable.

```
  BrickDescriptor                  registerCompanionSkills()        ForgeStore
  ┌───────────────────┐            ┌──────────────────────┐         ┌──────────────┐
  │ name: "@koi/soul"  │            │ for each descriptor: │         │              │
  │ kind: "middleware"  │──────────>│   for each skill:    │──save──>│ SkillArtifact│
  │ companionSkills: [ │            │     exists(id)?      │         │ id: sha256:… │
  │   { name, content }│            │     skip if yes      │         │ kind: "skill"│
  │ ]                  │            │     save if no       │         │ scope: global│
  └───────────────────┘            └──────────────────────┘         └──────────────┘
```

## Why It Exists

- L2 packages know best when their brick should be used, but that knowledge was trapped in READMEs
- Manual `seedSkills()` calls were easy to forget and created boilerplate
- The LLM needs copilot context to make good brick selection decisions during agent assembly
- Companion skills close the loop: package authors declare teaching prompts, the resolve pipeline registers them automatically

## How It Works

### 1. Declare companion skills on a descriptor

Any `BrickDescriptor` can include a `companionSkills` array:

```typescript
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  kind: "middleware",
  name: "@koi/sandbox",
  companionSkills: [
    {
      name: "when-to-use-sandbox",
      description: "Guidance on sandbox isolation",
      content: "Use sandbox when running untrusted code or shell commands.",
      tags: ["security"],
    },
  ],
  optionsValidator: validateSandboxConfig,
  factory: createSandboxMiddleware,
};
```

### 2. Resolve pipeline auto-registers

During `resolveAgent()`, after `discoverDescriptors()` returns all known descriptors, `registerCompanionSkills()` is called:

```
  resolveAgent()
       │
       ├── discoverDescriptors()        ← pure, no side effects
       │
       ├── registerCompanionSkills()    ← writes to ForgeStore
       │     │
       │     ├── computeBrickId("skill", content)  → content-addressed ID
       │     ├── forgeStore.exists(id)?             → skip if present
       │     └── forgeStore.save(artifact)          → persist
       │
       └── resolveManifest()            ← continues as before
```

### 3. LLM discovers the skills

Once in ForgeStore, companion skills are queryable like any other skill:

```
  forgeStore.search({ kind: "skill", tags: ["companion"] })
  → [{ name: "when-to-use-sandbox", content: "Use sandbox when..." }]
```

## Design Decisions

| Decision | Rationale |
|----------|-----------|
| Two-phase pipeline (discover then register) | Keeps `discoverDescriptors()` pure — no I/O side effects. Registration is a separate, explicit step |
| Content-addressed IDs | Same content always produces the same BrickId. Free deduplication and idempotency |
| Trust tier hardcoded to `"promoted"` | Package-shipped skills are pre-verified by the package author. No forge pipeline needed |
| Sequential ForgeStore writes | Cold-start path, <50ms total. Parallelism adds complexity for negligible gain |
| Partial failure tolerance | One skill failing to save doesn't block others. Errors are collected and logged |
| `CompanionSkillDefinition` is text-only | Companion skills are teaching prompts, not executable artifacts. Scripts and file attachments go through the full forge pipeline |

## CompanionSkillDefinition

```typescript
interface CompanionSkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly content: string;          // plain text prompt for the LLM
  readonly tags?: readonly string[];
}
```

## Resulting SkillArtifact

Each companion skill becomes a full `SkillArtifact` in ForgeStore:

| Field | Value |
|-------|-------|
| `id` | `sha256:<hash of "skill:" + content>` |
| `kind` | `"skill"` |
| `scope` | `"global"` |
| `trustTier` | `"promoted"` |
| `lifecycle` | `"active"` |
| `version` | `"0.1.0"` |
| `tags` | `[...skill.tags, "from:<descriptorName>", "companion"]` |
| `provenance.source` | `{ origin: "bundled", bundleName, bundleVersion }` |

## Layer Compliance

- `CompanionSkillDefinition` is defined in `@koi/core` (L0) — no new types needed
- `registerCompanionSkills` lives in `@koi/resolve` (L0u) — imports only from `@koi/core` (L0) and `@koi/hash` (L0u)
- CLI wiring is in `@koi/cli` (L3) — can import from everything
- No changes to `@koi/core` — all types already existed

## Related

- [Brick Auto-Discovery](./brick-auto-discovery.md) — how forged bricks flow to runtime
- `BrickDescriptor` — `packages/resolve/src/types.ts`
- `ForgeStore` — `packages/core/src/brick-store.ts`
