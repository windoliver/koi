# @koi/forge-tools

Primordial forge tools (L2) — first concrete `ForgeStore` implementation plus
four LLM-callable tools (`forge_tool`, `forge_middleware`, `forge_list`,
`forge_inspect`). Issue #1344, spec
`docs/superpowers/specs/2026-04-26-forge-tools-design.md`.

## Wiring

The package exports tool factories and `createInMemoryForgeStore`. Wire one
shared store into `@koi/runtime`'s `createKoi`, then attach the four tools to
the agent assembly. **Do not** expose the raw `ForgeStore` to LLM-controlled
paths — authorization lives only at the tool wrappers.

**Deployment prerequisite:** the in-memory store is per-process. Multiple
agents must not share a single `Map`-backed store; visibility is enforced via
`ForgeQuery.createdBy` at the L2 boundary, but the per-process invariant lets
list latency stay bounded by one agent's own synthesis count.

## Surface

- `createInMemoryForgeStore(): ForgeStore` — concrete `Map`-backed impl.
- `createForgeToolTool({ store }): Tool` — synthesize `ToolArtifact`.
- `createForgeMiddlewareTool({ store }): Tool` — synthesize `ImplementationArtifact` with `kind: "middleware"`.
- `createForgeListTool({ store }): Tool` — bounded list via `createdBy` query.
- `createForgeInspectTool({ store }): Tool` — by-id inspect with visibility predicate.

## Out of scope

`zone` synthesis (rejected with `INVALID_INPUT`), `global` synthesis (rejected
with `FORBIDDEN` until capability plumbing lands), `ForgePipeline` /
verification / governance, component provider, resolver, registry sync.
