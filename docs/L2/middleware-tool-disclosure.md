# @koi/middleware-tool-disclosure — Progressive Tool Disclosure

When the agent has access to many tools, sending every full tool descriptor on every model call wastes huge amounts of context. This middleware swaps full descriptors for lightweight summaries above a configurable threshold, and lets the model promote specific tools to full schema on demand via a companion `promote_tools` tool.

---

## Why It Exists

Each `ToolDescriptor` with a real `inputSchema` costs ~200–500 tokens. With 200+ tools the model spends 60K+ tokens just enumerating capabilities — before user turn one. Most of those tools will never be called.

Strategy: at discovery time the model sees `name + description` only (~20 tokens each); when it decides to use a tool it calls `promote_tools(["name1","name2"])` and the next model call includes the full schema for those tools.

Token math (200 tools, 250 tokens/full descriptor):
- Without disclosure: 50 000 tokens per call
- With disclosure (after promoting 5): 200 × 20 + 5 × 250 = 5 250 tokens
- Savings: ~89%

---

## Architecture

L2 feature package. Depends only on `@koi/core` (L0).

```
┌────────────────────────────────────────────────────────┐
│  @koi/middleware-tool-disclosure  (L2)                 │
│                                                        │
│  tool-disclosure-middleware.ts ← middleware factory    │
│  disclosure-bundle.ts          ← bundle (mw + tool)    │
│  index.ts                      ← public API            │
├────────────────────────────────────────────────────────┤
│  Dependencies                                          │
│  @koi/core (L0)  KoiMiddleware, ModelRequest,          │
│                   ToolDescriptor, MiddlewareBundle,    │
│                   Tool, ComponentProvider,              │
│                   createSingleToolProvider              │
└────────────────────────────────────────────────────────┘
```

No external dependencies. No `ForgeStore` coupling — promotion lifts tools from the existing input descriptor list.

---

## How It Works

### Phase 1: `wrapModelCall`

```
ModelRequest                     promoted: Set<string>
  │  tools: ToolDescriptor[]            │
  ▼                                     ▼
┌─────────────────────────────────────────────────┐
│ request.tools.length <= threshold? ─── yes ──▶  │ next(request)  passthrough
│                                                  │
│         no                                       │
│         ▼                                        │
│ for each tool:                                   │
│   promoted.has(tool.name)                        │
│     OR tool.name === "promote_tools"             │
│       ─── yes ──▶ keep full descriptor           │
│       ─── no  ──▶ strip inputSchema → summary    │
│                                                  │
└─────────────────────────────────────────────────┘
                 │
                 ▼
   next({ ...request, tools: disclosedTools })
```

### Phase 2: `promote_tools` companion tool

The bundle factory wires a `promote_tools` Tool that calls `middleware.promoteByName(names)`. Promoted names are added to the middleware's internal Set; subsequent model calls include their full schema.

Tools are only promoted if they exist in the input descriptor list. Unknown names are silently skipped. The companion tool returns the list of names actually promoted.

### Fail-closed enforcement

Above the threshold, undisclosed tools are advertised with `inputSchema: {}`. The engine's argument validator runs against the *advertised* schema, which means an empty schema accepts arbitrary args. To prevent malformed args from reaching the real tool implementation, `wrapToolCall` rejects direct calls to known-but-not-promoted tools with a `VALIDATION` error that tells the model to promote the tool first.

Trace of a successful flow:

```
1. wrapModelCall: tools=[a,b,c,d,...] → model sees a,b,c,d at summary
2. model emits tool call: promote_tools(["c"])
3. wrapToolCall intercepts → c added to session.promoted
4. wrapModelCall (next turn): c is promoted → full schema sent
5. model emits tool call: c({foo: "bar"})
6. wrapToolCall: c in promoted → next(request) → c.execute
```

Trace of a fail-closed flow:

```
1. wrapModelCall: tools=[a,b,c,d,...] → model sees summaries
2. model skips promote_tools and calls c({foo: "bar"}) directly
3. wrapToolCall: c known but not promoted → returns VALIDATION error
4. model sees the error, calls promote_tools(["c"])
5. retry — now allowed
```

Below the threshold the guard is inert (no disclosure happened — `state.knownNames` is empty for that session).

### Per-session state

Promotion state is keyed by `SessionId` so concurrent or interleaved sessions sharing one middleware instance cannot corrupt each other. Per-session entries are populated lazily on first `wrapModelCall` (and via `onSessionStart`) and torn down on `onSessionEnd`.

The `promote_tools` companion tool's `execute()` has no `SessionId` in scope (Tool.execute receives only `args` and an abort signal), so it targets the session whose `wrapModelCall` was most recently invoked. This matches the engine's serial per-session execution model. Callers needing explicit session targeting (custom dispatchers, multi-tenant runtimes) should use `middleware.promoteByNameForSession(sid, names)` instead of relying on the companion tool.

### Phase / priority

| Field | Value | Reason |
|-------|-------|--------|
| `phase` | `"intercept"` | Mutates the request before downstream middleware sees it |
| `priority` | `50` | Run early — other middleware should see disclosed tools, not full ones |

---

## Configuration

```typescript
interface ToolDisclosureConfig {
  /** Tool count threshold; below this, all tools pass through unchanged. Default: 50. */
  readonly threshold?: number;
}
```

That's it. No store, no estimator, no cache capacity.

---

## Two Usage Modes

### Standalone middleware

```typescript
const mw = createToolDisclosureMiddleware({ threshold: 50 });
// register middleware on the agent
// agent has no way to promote tools; useful when full schemas are
// always wanted but the model needs a token budget signal
```

In standalone mode `describeCapabilities` returns `undefined` so the model is not told about a non-existent `promote_tools` tool.

### Bundle (middleware + companion tool)

```typescript
const bundle = createToolDisclosureBundle({ threshold: 50 });
// register bundle.middleware on the agent
// register bundle.providers on the agent's ECS
// agent can now call promote_tools("name1","name2") to get full schemas
```

In bundle mode `describeCapabilities` advertises the `promote_tools` tool and the current promoted-count.

---

## Companion Tool Surface

```typescript
{
  name: "promote_tools",
  description: "Load full tool schemas for the named tools. Call this before using a tool whose inputSchema is empty (summary-level). Returns the list of successfully promoted tool names.",
  inputSchema: {
    type: "object",
    properties: {
      names: { type: "array", items: { type: "string" } },
    },
    required: ["names"],
  },
}
```

Return shape (success):
```json
{ "ok": true, "promoted": ["name1","name2"], "message": "Promoted 2 tool(s): name1, name2." }
```

Return shape (validation failure):
```json
{ "ok": false, "error": { "code": "VALIDATION", "message": "..." } }
```

The companion tool itself is always full-descriptor — even above the threshold — so the model can always escape summary mode.

---

## Non-Goals

- **Tool selection / ranking** — that belongs to `@koi/middleware-tool-selector`. Disclosure is mechanical (token reduction), not semantic (relevance).
- **ForgeStore-backed promotion** — v1 had a `ForgeStore` path that was dead code (`brickIdLookup` always returned `undefined`). Promotion is purely list-internal. If a tool is not in the request's descriptor list, it cannot be promoted.
- **Cache eviction** — promoted state is per-session; entries are torn down on `onSessionEnd`. Fine for a few hundred entries per session; not designed as a long-lived cache.
- **Token estimation** — no budget-aware logic. If you need that, layer a cost middleware around this one.
