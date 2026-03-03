# Brick Agent Dependencies (`requires.agents`)

Bricks can now declare agent dependencies alongside tool dependencies using
the `requires.agents` field on `BrickRequires`.

**Layer**: L0 type (`@koi/core`), enforced in L1 (`@koi/engine`) and L2 (`@koi/forge`)
**Issue**: #554

---

## Problem

A skill like "deep-research" may need a `web-crawler` copilot and a `summarizer`
worker, but before this feature there was no way to declare that dependency.
The result: silent runtime failures, no discoverability at assembly time, and
no tooling support.

```yaml
# Before: only tool dependencies were expressible
requires:
  tools: ["web-search"]
  # agents: ???  ← no way to declare this
```

## Solution

`BrickRequires` now supports an optional `agents` field — an array of agent
brick names that must be resolvable as peer dependencies:

```typescript
interface BrickRequires {
  readonly bins?: readonly string[];
  readonly env?: readonly string[];
  readonly tools?: readonly string[];
  readonly agents?: readonly string[];     // ← NEW
  readonly packages?: Readonly<Record<string, string>>;
  readonly network?: boolean;
}
```

## What it enables

### 1. Declarative agent dependencies for skills

A skill that orchestrates multiple agents can now declare those
dependencies explicitly:

```yaml
# deep-research skill
requires:
  tools: ["web-search"]
  agents: ["web-crawler", "summarizer"]
```

### 2. Assembly-time warnings

When `createKoi()` assembles an agent, the `koi:brick-requires` kernel
extension checks that all declared agent dependencies are present as
`agent:*` components. Missing agents produce a warning:

```
[koi] Skill "deep-research" requires agent "web-crawler" which is not available.
      The skill may not function correctly.
```

Assembly is never blocked — warnings only.

### 3. Runtime enforcement in ForgeComponentProvider

When the forge component provider attaches bricks to an agent, it checks
`requires.agents` against all active agent bricks in the same scope/zone.
Bricks with unsatisfied agent requirements are skipped:

```
skipped: "deep-research" — unsatisfied requires: agent:web-crawler
```

### 4. Runtime enforcement in ForgeRuntime

The `resolve()` method in `ForgeRuntime` also validates agent dependencies
before returning resolved bricks. This ensures hot-loaded bricks mid-session
respect agent dependency constraints.

### 5. Forge tool schema support

All five forge tools (`forge_skill`, `forge_agent`, `forge_tool`,
`forge_middleware`, `forge_channel`) accept `agents` in their
`requires` input:

```json
{
  "name": "deep-research",
  "description": "Multi-agent research skill",
  "body": "# Deep Research\n...",
  "requires": {
    "tools": ["web-search"],
    "agents": ["web-crawler", "summarizer"]
  }
}
```

## Enforcement order (fail-fast)

`checkBrickRequires` validates in this order, returning the first violation:

```
bins → env → tools → agents → packages → network
```

## Architecture

```
L0  @koi/core
    └── BrickRequires.agents?: readonly string[]     (type definition)

L1  @koi/engine
    └── brick-requires-extension.ts                  (assembly-time warning)
        Collects tool:* and agent:* keys from components map
        Warns for each missing dependency in requires.tools / requires.agents

L2  @koi/forge
    ├── requires-check.ts                            (runtime check)
    │   checkBrickRequires(requires, toolNames, networkPolicy?, agentNames?)
    │   ViolationKind: "bin" | "env" | "tool" | "agent" | "package" | "network"
    │
    ├── forge-component-provider.ts                  (component attachment)
    │   Pass 1: collects both tool + agent names (single loop)
    │   Pass 2: passes agentNames to checkBrickRequires
    │
    ├── forge-runtime.ts                             (hot-load resolution)
    │   resolve() passes agent cache to checkBrickRequires
    │
    └── tools/shared.ts                              (DRY helper)
        mapParsedRequires() — maps parsed Zod input to BrickRequires
```

## Performance

No regression. The component provider's Pass 1 already iterated all bricks —
agent name collection is an `else if` branch in the same loop. The engine
extension combines tool+agent collection in a single pass over the components
map. `forge-runtime.resolve()` adds one `ensureKindCache("agent")` call which
is cached after first invocation.
