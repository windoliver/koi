# @koi/skill-tool

**Layer:** L2  
**Location:** `packages/lib/skill-tool`  
**Purpose:** SkillTool meta-tool for on-demand skill loading, advertising, and fork dispatch.

Creates a `Skill` tool that the model can invoke to discover and execute skills on demand. Skills are advertised in the tool description (budget-aware) and dispatched as inline body injection or fork-mode spawn.

## Architecture

```
createSkillTool(config)
  ├── discover()              ← calls resolver to get skill metadata
  ├── formatSkillDescription() ← budget-aware skill listing (3-phase)
  ├── execute({ skill, args? })
  │     ├── extractSpawnConfig()  ← determines inline vs fork mode
  │     ├── inline: substituteVariables() → return body
  │     └── fork: mapSkillToSpawnRequest() → spawnFn()
  └── returns Tool (name: "Skill", origin: primordial)
```

### Execution Modes

**Inline (default):** Loads the skill body via `resolver.load(name)`, substitutes `${SKILL_DIR}` and `${SESSION_ID}` variables, and returns the body as tool_result content.

**Fork:** When a skill declares `executionMode: "fork"` or has a `metadata.agent` field, delegates to `SpawnFn`. The skill body becomes the child agent's `systemPrompt`. Fork mode uses `fork: true` for unrestricted tools (with engine recursion guard) or `toolAllowlist` + explicit `maxTurns` for restricted tools.

### Skill Advertising

The Skill tool description dynamically lists available skills. Three-phase budget formatting within `MAX_DESCRIPTION_CHARS` (8000):

1. **Full**: `"- name: description"` for all skills
2. **Truncated**: Bundled keep full; non-bundled truncated to 250 chars
3. **Names-only**: Just `"- name"` with overflow indicator

Only executable skills are advertised — fork skills are filtered out when `spawnFn` is absent.

### Variable Substitution

| Variable | Value | Notes |
|----------|-------|-------|
| `${SKILL_DIR}` | Skill's `dirPath` | Always substituted |
| `${SESSION_ID}` | Config `sessionId` | Substituted when provided |
| `${ARGS}` | Tool invocation args | Inline mode only; NOT injected into fork `systemPrompt` (prompt injection prevention) |

Unknown `${...}` patterns are left as-is.

### Security

- **Fork recursion guard:** Reserved spawn tools (`agent_spawn`, `Spawn`) are hard-filtered from fork allowlists
- **Fail-closed spawn validation:** Empty `allowedTools`, reserved-only allowlists, and missing `spawnFn` for fork skills return typed errors — never silently degrade to inline
- **executionMode is authoritative:** Explicit `executionMode: "inline"` takes precedence over `metadata.agent`
- **Per-call signal composition:** `AbortSignal.any([factory, call])` for cooperative cancellation

## Public API

```typescript
import { createSkillTool } from "@koi/skill-tool";
import type { SkillToolConfig, SkillResolver } from "@koi/skill-tool";
```

### `createSkillTool(config: SkillToolConfig): Promise<Result<Tool, KoiError>>`

Async factory. Calls `resolver.discover()` to build the tool description, returns a `Tool` that loads skills lazily at invocation time.

### `extractSpawnConfig(skill: SkillMeta): Result<SpawnConfig, KoiError>`

Validates spawn configuration from skill metadata. Returns `NOT_FOUND` for inline-only skills, `VALIDATION` for invalid fork configs.

### `mapSkillToSpawnRequest(skill, args, spawnConfig, config): SpawnRequest`

Maps a loaded skill with validated spawn config into a `SpawnRequest`. Always uses `fork: true` for unrestricted fork or `toolAllowlist` + `maxTurns` for restricted fork.

### `substituteVariables(body: string, vars: SkillVariables): string`

Replaces known `${VAR}` placeholders. Unset variables left as-is.

### `formatSkillDescription(skills, budget?): string`

Budget-aware skill listing with 3-phase truncation.

## Dependencies

- `@koi/core` (L0) — `Tool`, `SpawnFn`, `SpawnRequest`, `DEFAULT_SANDBOXED_POLICY`, `Result`, `KoiError`
- `zod` — input validation

Uses structural typing (`SkillResolver`) to avoid cross-L2 imports from `@koi/skills-runtime`.

## Integration

```typescript
import { createSkillsRuntime } from "@koi/skills-runtime";
import { createSkillTool } from "@koi/skill-tool";

const runtime = createSkillsRuntime();
const result = await createSkillTool({
  resolver: runtime,      // structurally compatible
  signal: controller.signal,
  spawnFn: mySpawnFn,     // optional, enables fork mode
  sessionId: "session-1", // optional, for ${SESSION_ID}
});
if (result.ok) {
  // result.value is a Tool — add to agent's tool set
}
```
