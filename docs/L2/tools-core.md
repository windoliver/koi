# @koi/tools-core

Tool type bridge, registry, and ComponentProvider adapter for the Koi agent engine.

## Layer

L2 — depends on `@koi/core` (L0), `@koi/errors` (L0u), `@koi/validation` (L0u), `zod`.

## Purpose

Bridges the gap between rich tool definitions (with coarse capability flags) and the
L0 `Tool` contract. Provides three composable primitives:

1. **`buildTool()`** — Factory that accepts a `ToolDefinition` (rich input) and returns
   a validated L0 `Tool` with sensible defaults for origin, policy, and tags.
2. **`assembleToolPool()`** — Normalizes, deduplicates, and sorts a collection of tools
   into a deterministic pool. Dedup rule: `primordial > operator > forged`.
3. **`createToolComponentProvider()`** — Wraps a tool pool into a `ComponentProvider`
   that attaches each tool under its `toolToken(name)` key.

## Public API

### `buildTool(definition: ToolDefinition): Result<Tool, KoiError>`

Validates the definition with Zod and returns a `Result`. On success, produces a `Tool`
with:

- `descriptor` mapped from `name`, `description`, `inputSchema`, `tags`
- `origin` defaulting to `"operator"` if omitted
- `policy` derived from coarse flags (`sandbox`, `network`, `filesystem`) or falling
  back to `DEFAULT_SANDBOXED_POLICY`
- `execute` forwarded from the definition

### `assembleToolPool(tools: readonly Tool[]): readonly Tool[]`

- Deduplicates by `descriptor.name` — when names collide, the tool with higher origin
  precedence wins: `primordial` (0) > `operator` (1) > `forged` (2).
- Sorts the result alphabetically by name for deterministic ordering.
- Returns a new frozen array (never mutates the input).

### `createToolComponentProvider(config: ToolComponentProviderConfig): ComponentProvider`

Returns a `ComponentProvider` with:

- `name` from config (e.g., `"tools-core"`)
- `priority` from config (defaults to `COMPONENT_PRIORITY.BUNDLED`)
- `attach()` that calls `assembleToolPool()` on the provided tools, then returns a
  `ReadonlyMap` keyed by `toolToken(tool.descriptor.name)` for each tool.

### Types

#### `ToolDefinition`

Rich input type accepted by `buildTool()`:

```typescript
interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly tags?: readonly string[];
  readonly origin?: ToolOrigin;
  readonly sandbox?: boolean;
  readonly network?: boolean;
  readonly filesystem?: { readonly read?: readonly string[]; readonly write?: readonly string[] };
  readonly execute: (args: JsonObject, options?: ToolExecuteOptions) => Promise<unknown>;
}
```

#### `ToolComponentProviderConfig`

```typescript
interface ToolComponentProviderConfig {
  readonly name: string;
  readonly tools: readonly Tool[];
  readonly priority?: number;
}
```

## Policy Mapping Rules

| `sandbox` | `network` | Result |
|-----------|-----------|--------|
| omitted   | omitted   | `DEFAULT_SANDBOXED_POLICY` |
| `true`    | omitted   | `DEFAULT_SANDBOXED_POLICY` |
| `false`   | omitted   | `DEFAULT_UNSANDBOXED_POLICY` |
| `true`    | `true`    | sandboxed + `network: { allow: true }` |
| any       | `false`   | inherits base + `network: { allow: false }` |

When `filesystem` is provided, its paths are merged into the policy.

## Dedup Precedence

`primordial` (0) > `operator` (1) > `forged` (2)

When two tools share the same `descriptor.name`, the one with higher precedence wins.
Ties are resolved by keeping the first occurrence (stable ordering).

## Non-goals

- Tool visibility filtering (middleware / L1 concern)
- Permission decisions (`@koi/permissions`)
- Tool batching / concurrency (`@koi/tool-execution`)
- Tool discovery / resolution (Resolver contract)
