---
name: handoff-relay
description: Teaches agents how to use prepare_handoff and accept_handoff tools for structured context relay in multi-agent pipelines.
allowed-tools: prepare_handoff accept_handoff
metadata:
  author: koi-team
  category: orchestration
---

# Handoff Relay

Use `prepare_handoff` and `accept_handoff` to pass structured context between agents in a pipeline.

## When to Use

Call `prepare_handoff` when:
- You have completed a phase of work and another agent needs to continue
- You want to relay structured results, artifacts, decisions, or warnings
- The next agent needs context about what was accomplished and what to do next

Call `accept_handoff` when:
- You see handoff context injected into your system message (the middleware auto-injects it)
- You need the full structured data (results, artifacts, decisions) to continue work
- The system message will tell you the `handoff_id` to use

## prepare_handoff

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `to` | string | Target agent ID that will receive this handoff |
| `completed` | string | Summary of what you accomplished in this phase |
| `next` | string | Instructions for the next agent — what they should do |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `results` | object | Structured data (JSON) the next agent needs |
| `artifacts` | array | References to files/resources (`{ id, kind, uri }`) |
| `decisions` | array | Decision records with reasoning |
| `warnings` | array | Pitfalls or caveats for the next agent |
| `delegation` | object | Delegation grant to forward permissions |
| `metadata` | object | Arbitrary metadata |

### Writing Good Descriptions

**`completed`** should describe *outcomes*, not process:
- Good: "Analyzed 50 test files, identified 12 failing tests across 3 modules"
- Bad: "I looked at the tests"

**`next`** should be *actionable instructions*:
- Good: "Fix the 12 failing tests. Start with auth module (6 failures). The root cause is a missing mock for UserService."
- Bad: "Fix the tests"

### Example

```json
{
  "to": "implementer-agent",
  "completed": "Designed REST API with 5 endpoints for user management",
  "next": "Implement the API endpoints using Express.js. Follow the schema in results.",
  "results": {
    "endpoints": [
      { "method": "GET", "path": "/users", "description": "List users" },
      { "method": "POST", "path": "/users", "description": "Create user" }
    ]
  },
  "artifacts": [
    { "id": "api-spec", "kind": "file", "uri": "file:///workspace/api-spec.yaml" }
  ],
  "warnings": ["Rate limiting is not yet configured", "Auth middleware must be added"]
}
```

## accept_handoff

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `handoff_id` | string | The envelope ID from the injected system message |

### When to Call

After the middleware injects a handoff summary into your context, call `accept_handoff` with the provided ID to get the full structured data. The summary gives you an overview; accepting gives you the complete `results`, `artifacts`, `decisions`, and `warnings`.

### Example

```json
{
  "handoff_id": "abc-123-def"
}
```

### Response

Returns the full envelope contents:
- `handoffId` — the accepted envelope ID
- `from` — the agent that prepared this handoff
- `phase` — `{ completed, next }` descriptions
- `results` — structured data
- `artifacts` — file/resource references
- `decisions` — decision records with reasoning
- `warnings` — pitfalls and caveats
- `delegation` — forwarded permissions (if any)
- `metadata` — arbitrary metadata

## Pipeline Pattern

In multi-agent pipelines (A -> B -> C), warnings accumulate:

1. **Agent A** prepares with `warnings: ["Budget constraint"]`
2. **Agent B** accepts, does its work, then prepares for C with `warnings: ["Budget constraint", "Use existing auth library"]`
3. **Agent C** receives all accumulated warnings

Each agent should review incoming warnings and forward relevant ones to the next agent.

## Anti-Patterns

- **Don't call `accept_handoff` without a pending handoff** — if no handoff context was injected, there's nothing to accept
- **Don't skip the accept step** — the summary in the system message is a preview; always accept to get full structured data
- **Don't duplicate results in the description** — put structured data in `results`, keep `completed`/`next` as human-readable summaries
- **Don't forget to forward warnings** — downstream agents need to know about upstream constraints
