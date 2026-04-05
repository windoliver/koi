# @koi/agent-runtime

Agent definition model — built-in and custom agent loading with validation.

## Purpose

Provides the `AgentDefinition` loading pipeline: parse Markdown agent files, validate with Zod, register with priority-based dedup, and adapt to the L0 `AgentResolver` contract.

## Agent Definition Model

An `AgentDefinition` (L0 type in `@koi/core`) wraps an `AgentManifest` with discovery metadata:

| Field | Type | Description |
|-------|------|-------------|
| `agentType` | `string` | Lookup key (e.g., `"researcher"`, `"code-reviewer"`) |
| `whenToUse` | `string` | LLM-facing description for tool descriptors |
| `source` | `AgentDefinitionSource` | `"built-in"` \| `"user"` \| `"project"` |
| `manifest` | `AgentManifest` | Full runtime configuration |
| `brickId?` | `BrickId` | Content-addressed ID (forge-backed resolvers) |

## Markdown Format

Custom agents are `.md` files with YAML frontmatter:

```markdown
---
name: researcher
description: Deep research agent for complex questions
model: sonnet
tools: [Read, Grep, Glob, WebSearch]
---

You are a research specialist. Your job is to...
```

**Required fields**: `name`, `description`.
**Optional fields**: `model` (default: `"sonnet"`).

The schema is **strict** — unknown keys are rejected. This prevents users from configuring fields that aren't enforced yet (e.g., `tools`, `permissions`, `maxTurns`). Those will be added when spawn enforcement lands (#1424, #1425).

The Markdown body becomes the agent's system prompt (stored in `AgentDefinition.systemPrompt`).

## Agent Type Naming

Agent type names must match: `[a-zA-Z0-9][a-zA-Z0-9-]*[a-zA-Z0-9]`, 3-50 chars.

Valid: `researcher`, `code-reviewer`, `qa-agent-v2`.
Invalid: `../../etc`, `-bad`, `a`, `my agent`.

## Priority / Override Model

Three tiers, higher overrides lower:

| Priority | Source | Directory |
|----------|--------|-----------|
| 0 (lowest) | `built-in` | Bundled in package |
| 1 | `user` | `~/.koi/agents/` |
| 2 (highest) | `project` | `.koi/agents/` |

When a project agent and a built-in agent share the same `agentType`, the project agent wins.

## Built-in Agents

| Agent | Description |
|-------|-------------|
| `researcher` | Deep research across multiple sources |
| `coder` | Code implementation and editing |
| `reviewer` | Code review and feedback |
| `coordinator` | Multi-agent orchestrator — decomposes goals into tasks, fans out to child agents via `agent_spawn`, polls for completion, synthesizes results. Uses `opus` model. |

## API

### Convenience bootstrap (recommended)

```typescript
import { createAgentResolver } from "@koi/agent-runtime";

const { resolver, warnings, conflicts } = createAgentResolver({
  projectDir: process.cwd(), // scans .koi/agents/ for custom overrides
  userDir: "/home/user",     // optional: ~/.koi/agents/
});

// warnings: unparseable .md files (fail-closed: poisons the agentType slot)
// conflicts: same agentType in multiple files within one tier

const result = await resolver.resolve("researcher");
const summaries = await resolver.list();
```

`createAgentResolver` composes all four lower-level functions and is the preferred entry point. Pass `resolver` to `createRuntime({ resolver })` or directly to `createSpawnToolProvider`. `@koi/runtime` also accepts `config.agentDirs` as a shortcut that calls `createAgentResolver` internally.

### `list()` / `resolve()` correctness

`list()` returns `agentType` as the summary `name` field — not `manifest.name`. The LLM passes `agentType` to `agent_spawn`; returning a display label would cause routing failures. `resolve()` NOT_FOUND errors include available agent names to enable LLM self-correction.

### Low-level pipeline (advanced use only)

```typescript
import {
  getBuiltInAgents,
  loadCustomAgents,
  createAgentDefinitionRegistry,
  createDefinitionResolver,
} from "@koi/agent-runtime";

const builtIn = getBuiltInAgents();
const { agents: custom, warnings } = loadCustomAgents({ projectDir: "/path/to/project" });
const registry = createAgentDefinitionRegistry(builtIn, custom);
const resolver = createDefinitionResolver(registry);
```

## Layer

L2 — depends on `@koi/core` (L0) and `@koi/errors` (L0u) only.
