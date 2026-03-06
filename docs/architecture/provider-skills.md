# Provider Skills

Behavioral instructions bundled with tool providers.

## Overview

Tool providers ship with `SkillComponent` objects that teach agents _when_ and _how_ to use their tools. The tool descriptor tells the agent what a tool does; the skill tells it when to reach for it, what pitfalls to avoid, and how to compose it with other tools.

```
  Provider (L2)               Agent Entity (ECS)            Context Hydrator
  ┌──────────────┐            ┌──────────────────┐          ┌──────────────────┐
  │ attach()     │──merge()──>│ tool:task         │          │ resolveSkill()   │
  │              │            │ skill:task-spawn  │──query──>│ format as text   │
  │ returns Map  │            │                   │          │ prepend to       │
  │ with tool +  │            │                   │          │ model messages   │
  │ skill entry  │            │                   │          │                  │
  └──────────────┘            └──────────────────┘          └──────────────────┘
```

## How It Works

### Supply: Provider attaches the skill

Each provider's `attach()` returns a `ReadonlyMap` containing both tool and skill entries:

```typescript
// packages/task-spawn/src/provider.ts
return createSingleToolProvider({
  name: "task-spawn",
  toolName: "task",
  createTool: () => createTaskTool(config),
  extras: [[skillToken(TASK_SPAWN_SKILL_NAME) as string, TASK_SPAWN_SKILL]],
});
```

The skill is a static constant defined in a co-located `skill.ts` file:

```typescript
// packages/task-spawn/src/skill.ts
export const TASK_SPAWN_SKILL: SkillComponent = {
  name: "task-spawn",
  description: "When to delegate work to subagents...",
  content: `# Task — subagent delegation strategy\n\n## When to use task\n...`,
  tags: ["delegation", "subagent"],
} as const satisfies SkillComponent;
```

During assembly, `AgentEntity.assemble()` calls each provider's `attach()` and merges the returned entries into the agent's component map. The skill ends up at key `"skill:task-spawn"`.

### Demand: Manifest references the skill

The skill content reaches the LLM only when the agent's manifest declares it as a context source:

```yaml
# koi.yaml
context:
  sources:
    - kind: skill
      name: task-spawn
```

The context hydrator calls `agent.query<SkillComponent>("skill:")`, finds the matching skill by name, formats it as markdown, and prepends it to every model request as a system message.

## Packages With Provider Skills

| Package | Skill Name | Tools Covered |
|---------|-----------|---------------|
| `@koi/task-spawn` | `task-spawn` | `task` |
| `@koi/long-running` | `autonomous` | `plan_autonomous`, `task_complete`, `task_update`, `task_status`, `task_review`, `task_synthesize` |
| `@koi/code-mode` | `code-mode` | `code_plan_create`, `code_plan_apply`, `code_plan_status` |
| `@koi/scheduler-provider` | `scheduler` | `sched_submit`, `sched_cancel`, `sched_schedule`, + 6 more |
| `@koi/tools-web` | `web` | `web_fetch`, `web_search` |
| `@koi/handoff` | `handoff` | `prepare_handoff`, `accept_handoff` |
| `@koi/workspace` | `workspace` | (no tools — WORKSPACE component) |
| `@koi/tool-squash` | `squash` | `squash` |
| `@koi/memory-fs` | `memory` | `memory_store`, `memory_recall`, + more |
| `@koi/filesystem` | `filesystem` | `fs_read`, `fs_write`, `fs_edit`, + more |
| `@koi/tools-github` | `github` | `github_*` tools |
| `@koi/tool-browser` | `browser` | `browser_navigate`, `browser_click`, + more |
| `@koi/registry-sqlite` | `registry` | `registry_*` tools |

## Skill Content Template

Each skill follows a 4-section template:

1. **Overview** — what the tool does in one paragraph
2. **When to use / When NOT to use** — decision guidance
3. **Workflow** — step-by-step patterns, tool selection guides, composition with other tools
4. **Error handling** — what errors mean and how to recover

## Provider Skills vs Companion Skills

Two mechanisms exist for shipping skills with packages:

| | Provider Skills | Companion Skills |
|---|---|---|
| **Mechanism** | `attach()` returns skill in component Map | `BrickDescriptor.companionSkills` auto-registered to ForgeStore |
| **Used by** | Tool providers (ComponentProvider factories) | Engine adapters, channel adapters (BrickDescriptor factories) |
| **Registration** | Direct — skill goes into agent entity at assembly time | Indirect — skill goes to ForgeStore, then ForgeComponentProvider attaches it |
| **Requires** | Runtime config (spawn fns, backends, executors) | YAML-resolvable descriptor |
| **Examples** | task-spawn, long-running, filesystem | engine-claude, engine-pi, engine-loop |

Both paths converge: the skill ends up in `agent._components` under a `skill:<name>` key, queryable via `agent.query<SkillComponent>("skill:")`.

## The `extras` Field

`createSingleToolProvider` accepts an optional `extras` field for attaching additional components (typically skills) alongside the tool:

```typescript
interface SingleToolProviderConfig {
  readonly name: string;
  readonly toolName: string;
  readonly createTool: () => Tool | Promise<Tool>;
  readonly priority?: number | undefined;
  readonly extras?: ReadonlyArray<readonly [string, unknown]> | undefined;
}
```

This is a convenience for single-tool providers (task-spawn). Multi-tool providers (long-running, scheduler, code-mode) use manual Map construction and add the skill entry directly.

## Performance

- Skills are `as const` static objects — zero computation at runtime
- Evaluated once per provider, cached with the tool on subsequent `attach()` calls
- No I/O, no async, no dependencies beyond `@koi/core`
- Content is ~400-800 words of markdown per skill (~500-1000 tokens)
