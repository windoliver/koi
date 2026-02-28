# Engine Capability Cards

How engine descriptors teach the LLM which engine to pick when dynamically forging agents.

## The Problem

When the copilot dynamically creates an agent via `forge_agent`, the LLM has no information about what each engine does. There are 5 engine adapters (`pi`, `acp`, `loop`, `external`, `claude`) but zero metadata describing their capabilities, required options, or when to use one over another.

```
  forge_agent("Fix failing tests with Claude Code")
                        |
                        v
              +------------------+
              |   Copilot LLM    |
              |                  |
              |  Available:      |
              |    pi, acp,      |
              |    loop,         |
              |    external,     |
              |    claude        |
              |                  |
              |  "Which one???"  |
              +--------+---------+
                       |
                       v
                 engine: loop     <-- WRONG. inherits parent default.
                                      can't spawn Claude Code.
                                      task fails silently.
```

## The Solution

Each engine descriptor now includes a **companion skill** — a markdown document that teaches the LLM when and how to use that engine. These skills are auto-injected into the copilot's context (via #546), so the LLM makes informed engine selection decisions.

```
  forge_agent("Fix failing tests with Claude Code")
                        |
                        v
              +---------------------------------------------+
              |               Copilot LLM                   |
              |                                             |
              |  Context includes companion skills:         |
              |    engine-pi-guide       (multi-turn LLM)   |
              |    engine-acp-guide      (coding agents)    |
              |    engine-loop-guide     (default loop)     |
              |    engine-external-guide (CLI subprocess)   |
              |    engine-claude-guide   (Agent SDK)        |
              +---------------------+-----------------------+
                                    |
                                    |  LLM reasons:
                                    |  "Claude Code = ACP agent"
                                    |  "engine-acp-guide matches!"
                                    |
                                    v
                          +------------------+
                          |  engine:         |
                          |    name: acp     |  <-- CORRECT
                          |    options:      |
                          |      command:    |
                          |        claude    |
                          +------------------+
```

## Architecture

Capability cards span L0 and L0u, with data populated by L2 engine packages:

```
L0  @koi/core
    CompanionSkillDefinition      { name, description, content, tags? }
    (interface only — no logic)

L0u @koi/resolve
    BrickDescriptor<T>
    +-- description?: string       Human-readable summary
    +-- tags?: readonly string[]   Searchable categorization
    +-- companionSkills?: readonly CompanionSkillDefinition[]

L2  @koi/engine-{pi,acp,loop,external,claude}
    Each descriptor.ts populates description, tags, companionSkills
    with engine-specific markdown guides
```

### Data Flow

```
  BrickDescriptor (L2)          CompanionSkillDefinition (L0)
  +-------------------------+   +------------------------+
  | kind: "engine"          |   | name: "engine-acp-     |
  | name: "@koi/engine-acp" |-->|        guide"          |
  | description: "ACP..."  |   | description: "When to  |
  | tags: [acp, cli-agent]  |   |   use engine: acp"     |
  | companionSkills: [...]  |   | content: "# Engine:    |
  | optionsValidator: fn    |   |   acp\n## When..."     |
  | factory: fn             |   | tags: [engine, acp]    |
  +-------------------------+   +------------------------+
              |
              | #546 auto-injects as SkillComponent
              v
  +-------------------------+
  | Agent Entity (ECS)      |
  |                         |
  | skill:engine-pi-guide   |  SkillComponent
  | skill:engine-acp-guide  |  SkillComponent
  | skill:engine-loop-guide |  SkillComponent
  | ...                     |
  +-------------------------+
              |
              | visible in system prompt
              v
  +-------------------------+
  | Copilot reads skills,   |
  | picks the right engine  |
  | for forge_agent()       |
  +-------------------------+
```

## Types

### CompanionSkillDefinition (L0)

```typescript
// @koi/core — packages/core/src/ecs.ts
interface CompanionSkillDefinition {
  readonly name: string;        // unique identifier, e.g. "engine-pi-guide"
  readonly description: string; // short summary, e.g. "When to use engine: pi"
  readonly content: string;     // full markdown guide
  readonly tags?: readonly string[];
}
```

### BrickDescriptor extensions (L0u)

```typescript
// @koi/resolve — packages/resolve/src/types.ts
interface BrickDescriptor<T> {
  readonly kind: ResolveKind;
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;                              // NEW
  readonly tags?: readonly string[];                          // NEW
  readonly companionSkills?: readonly CompanionSkillDefinition[]; // NEW
  readonly optionsValidator: OptionsValidator<unknown>;
  readonly factory: BrickFactory<T>;
}
```

All three new fields are optional. Existing descriptors continue to work unchanged.

## Engine Guide Reference

| Engine | Description | Tags | Companion Skill |
|--------|-------------|------|-----------------|
| `pi` | Multi-turn LLM reasoning with pi-agent-core | `llm, streaming, thinking, tool-use` | `engine-pi-guide` |
| `acp` | ACP protocol for Claude Code, Codex, Gemini CLI | `acp, cli-agent, json-rpc, coding-agent` | `engine-acp-guide` |
| `loop` | Default lightweight ReAct loop in pure TypeScript | `default, react-loop, typescript` | `engine-loop-guide` |
| `external` | Arbitrary CLI subprocess engine | `cli, subprocess, external` | `engine-external-guide` |
| `claude` | Claude Agent SDK for Anthropic-native orchestration | `claude, agent-sdk, anthropic` | `engine-claude-guide` |

### Companion Skill Content Structure

Every companion skill follows a consistent template:

```markdown
# Engine: {name}

## When to use
- Primary use cases for this engine

## Manifest example
```yaml
engine:
  name: {alias}
  options:
    ...
```

## Required options
- Field descriptions

## Optional options
- Field descriptions

## When NOT to use
- Anti-patterns and alternatives
```

## How to Add a New Engine

When creating a new engine adapter package:

1. **Create the descriptor** in `packages/engine-{name}/src/descriptor.ts`
2. **Add metadata** — `description`, `tags`, and at least one companion skill
3. **Follow the template** — include all required sections (When to use, Manifest example, Required options, When NOT to use)
4. **Use unique names** — companion skill `name` must be unique across all descriptors
5. **Tag with "engine"** — include `"engine"` in the companion skill's tags
6. **Export from index** — re-export `descriptor` from `packages/engine-{name}/src/index.ts`

Example:

```typescript
import type { CompanionSkillDefinition, EngineAdapter } from "@koi/core";
import type { BrickDescriptor } from "@koi/resolve";

const MY_COMPANION_SKILL: CompanionSkillDefinition = {
  name: "engine-myengine-guide",
  description: "When to use engine: myengine",
  tags: ["engine", "my-tag"],
  content: `# Engine: myengine
## When to use
...
## Manifest example
...
## Required options
...
## When NOT to use
...
`,
};

export const descriptor: BrickDescriptor<EngineAdapter> = {
  kind: "engine",
  name: "@koi/engine-myengine",
  aliases: ["myengine"],
  description: "Short description of what this engine does",
  tags: ["my-tag"],
  companionSkills: [MY_COMPANION_SKILL],
  optionsValidator: validateOptions,
  factory: createAdapter,
};
```

## Testing

### Unit tests (per engine)

Each engine package has `descriptor.test.ts` verifying metadata presence:

```bash
bun test --cwd packages/engine-pi    -- src/descriptor.test.ts
bun test --cwd packages/engine-acp   -- src/descriptor.test.ts
bun test --cwd packages/engine-loop  -- src/descriptor.test.ts
bun test --cwd packages/engine-external -- src/descriptor.test.ts
bun test --cwd packages/engine-claude -- src/descriptor.test.ts
```

### Registry integration

`packages/resolve/src/registry.test.ts` verifies descriptors with new fields register correctly.

### E2E (real LLM)

`packages/engine/src/__tests__/e2e-capability-cards.test.ts` validates the full vertical slice:

```bash
E2E_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... bun test --cwd packages/engine -- src/__tests__/e2e-capability-cards.test.ts
```

Tests include:
- Registry: all 5 descriptors register with companion skills
- Metadata: well-formed content with required sections
- Agent assembly: companion skills queryable as `SkillComponent` on entity
- Runtime: `createKoi` + `createPiAdapter` streams text with skills attached
- Tool chain: LLM uses `lookup_engine` tool through middleware to query descriptor metadata
- Lifecycle: middleware hooks fire correctly with companion skills on agent

## Performance

Companion skills are `readonly` const data defined at module load time. Zero runtime overhead:

- No per-request computation
- No I/O — skills are static markdown strings
- No additional allocations during `createKoi()` assembly
- Skills are only injected into agent context once (at assembly time)

## Layer Compliance

```
L0  @koi/core
    CompanionSkillDefinition (interface only)
    Zero function bodies, zero imports from other packages

L0u @koi/resolve
    BrickDescriptor (3 new optional fields)
    Imports CompanionSkillDefinition from @koi/core

L2  @koi/engine-{pi,acp,loop,external,claude}
    Each populates description, tags, companionSkills
    Imports from @koi/core (L0) and @koi/resolve (L0u) only
    Zero cross-L2 imports
```

## Related

- [Manifest Resolution](../architecture/manifest-resolution.md) — how `BrickDescriptor` drives resolution
- [Capability Injection](./capability-injection.md) — how middleware describes capabilities to the LLM
- [#548](https://github.com/windoliver/koi/issues/548) — engine capability cards implementation issue
- [#546](https://github.com/windoliver/koi/issues/546) — auto-injection pipeline (future, consumes companion skills)
- [#550](https://github.com/windoliver/koi/issues/550) — content-block mapping (future)
