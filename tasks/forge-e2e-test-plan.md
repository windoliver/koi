# Forge Stack E2E Test Plan — Real LLM via Admin API

## Prerequisites

- `koi up` running with forge enabled (demo preset)
- Nexus healthy at `http://localhost:2026`
- Admin API at `http://localhost:3100/admin/api`
- Agent running (visible at `GET /admin/api/agents`)

## API Reference

| Action | Endpoint |
|--------|----------|
| Send message | `POST /admin/api/agents/:id/chat` |
| List agents | `GET /admin/api/agents` |
| Forge bricks | `GET /admin/api/view/forge/bricks` |
| Forge events | `GET /admin/api/view/forge/events` |
| Forge stats | `GET /admin/api/view/forge/stats` |
| Promote brick | `POST /admin/api/cmd/forge/bricks/:id/promote` |
| Demote brick | `POST /admin/api/cmd/forge/bricks/:id/demote` |
| Quarantine brick | `POST /admin/api/cmd/forge/bricks/:id/quarantine` |
| SSE events | `GET /admin/api/events` |
| Health | `GET /admin/api/health` |

---

## Scenario 1: User teaches copilot a new tool

**Packages:** `forge-tools`, `forge-verifier`, `forge-integrity`, `forge-policy`, `forge-types`

**What the user does:** Asks the copilot to create a reusable tool, then uses it.

### Steps

```
Step 1: Send message
  POST /admin/api/agents/:id/chat
  Body: "I need a tool that converts Celsius to Fahrenheit.
         Create it using forge_tool. Name it 'celsius_to_f'.
         Implementation: 'return { fahrenheit: Number(input.celsius) * 9/5 + 32 };'
         Input schema: { type: 'object', properties: { celsius: { type: 'number' } }, required: ['celsius'] }"

  Wait for response (SSE stream completes)

Step 2: Verify brick was created
  GET /admin/api/view/forge/bricks

  Expected: bricks list contains entry with name "celsius_to_f"
  Check: lifecycle = "active", kind = "tool"

Step 3: Use the forged tool
  POST /admin/api/agents/:id/chat
  Body: "Use celsius_to_f to convert 100 degrees Celsius"

  Wait for response

  Expected: response contains "212" (100°C = 212°F)

Step 4: Search for it
  POST /admin/api/agents/:id/chat
  Body: "Use search_forge to find my celsius tool"

  Expected: response mentions celsius_to_f brick
```

### Verify in Nexus

```
Check Nexus directly for brick persistence:
  The brick should exist at path: agents/{agentId}/bricks/{brickId}.json
  Verify via: GET /admin/api/view/forge/bricks → brickId →
              curl Nexus RPC: { method: "exists", params: { path: "bricks/{brickId}.json" } }
```

---

## Scenario 2: Capability gap detection

**Packages:** `forge-demand` (capability_gap via wrapModelStream), `crystallize/auto-forge`

**What the user does:** Asks for something requiring a tool that doesn't exist. The copilot says "I can't" → demand detector picks up the gap pattern.

### Steps

```
Step 1: First request (capability gap pattern triggers)
  POST /admin/api/agents/:id/chat
  Body: "Generate a PDF report of the employee salary data"

  Wait for response
  Expected: copilot says something like "I don't have a PDF generation tool"

Step 2: Second request (same gap, count reaches threshold)
  POST /admin/api/agents/:id/chat
  Body: "I need a PDF export of the customer revenue breakdown"

  Wait for response
  Expected: copilot again mentions lacking PDF capability

Step 3: Check forge events
  GET /admin/api/view/forge/events

  Expected: demand_detected event with triggerKind = "capability_gap"

Step 4: Check if pioneer was created
  GET /admin/api/view/forge/bricks

  Expected: pioneer brick related to PDF/report generation
  (may or may not appear depending on auto-forge confidence threshold)
```

---

## Scenario 3: Repeated tool failure → demand signal

**Packages:** `forge-demand` (repeated_failure), `crystallize/auto-forge`, `middleware-feedback-loop`

**What the user does:** Uses exec tool with code that crashes every time. After 3 failures, demand fires.

### Steps

```
Step 1: First failure
  POST /admin/api/agents/:id/chat
  Body: "Use exec to run this code: throw new Error('service down')"

  Wait for response (tool fails, copilot reports error)

Step 2: Second failure
  POST /admin/api/agents/:id/chat
  Body: "Try exec again with: throw new Error('still down')"

  Wait for response

Step 3: Third failure (threshold crossed)
  POST /admin/api/agents/:id/chat
  Body: "One more try with exec: throw new Error('broken')"

  Wait for response

Step 4: Check demand signals
  GET /admin/api/view/forge/events

  Expected: demand_detected event with:
    triggerKind = "repeated_failure"
    confidence >= 0.8

Step 5: Check forge stats
  GET /admin/api/view/forge/stats

  Expected: demandSignalsEmitted >= 1
```

---

## Scenario 4: Promote and demote via admin API

**Packages:** `forge-tools` (promote_forge), `forge-policy`, admin commands

**What the user does:** Creates a tool, then promotes/demotes it via admin API commands.

### Steps

```
Step 1: Ensure a brick exists (from Scenario 1, or create one)
  GET /admin/api/view/forge/bricks
  Pick a brickId from the list

Step 2: Promote the brick
  POST /admin/api/cmd/forge/bricks/:brickId/promote

  Expected: 200 OK or 501 NOT_IMPLEMENTED (for seeded/primordial bricks)

Step 3: Demote the brick
  POST /admin/api/cmd/forge/bricks/:brickId/demote

  Expected: 200 OK

Step 4: Quarantine the brick
  POST /admin/api/cmd/forge/bricks/:brickId/quarantine

  Expected: 200 OK

Step 5: Verify state change
  GET /admin/api/view/forge/bricks

  Expected: brick lifecycle changed (promoted → demoted → quarantined)
```

---

## Scenario 5: Forge tool with name dedup (Issue #1081 regression)

**Packages:** `crystallize/auto-forge` (name dedup), `forge-tools`

**What the user does:** Creates the same tool twice. Second attempt should be deduped.

### Steps

```
Step 1: Create a tool
  POST /admin/api/agents/:id/chat
  Body: "Use forge_tool to create a tool called 'my_greeter' that returns
         { greeting: 'Hello ' + input.name }. Input: { name: string }"

  Wait for response

Step 2: Check bricks
  GET /admin/api/view/forge/bricks
  Count bricks with name "my_greeter" → should be 1

Step 3: Try to create the same tool again
  POST /admin/api/agents/:id/chat
  Body: "Use forge_tool to create another tool called 'my_greeter' that returns
         { greeting: 'Hi ' + input.name }. Input: { name: string }"

  Wait for response

Step 4: Check bricks again
  GET /admin/api/view/forge/bricks
  Count bricks with name "my_greeter" → should still be 1 (deduped by name)

  Expected: forgesConsumed = 0 on the second attempt (name dedup caught it)
```

---

## Scenario 6: SSE event stream verification

**Packages:** `forge-event-bridge`, `dashboard-api/sse`

**What the user does:** Monitors the SSE stream while performing forge operations.

### Steps

```
Step 1: Open SSE connection
  GET /admin/api/events (keep connection open, collect events)

Step 2: Perform a forge operation (e.g., create a tool from Scenario 1)
  POST /admin/api/agents/:id/chat
  Body: "Use forge_tool to create 'sse_test_tool' ..."

Step 3: Check SSE stream
  Expected events in stream:
    - { kind: "forge", subKind: "brick_forged" } or { subKind: "brick_demand_forged" }
    - Possibly { subKind: "fitness_flushed" } if tool was also used

Step 4: Close SSE connection
```

---

## Scenario 7: Full session lifecycle → optimizer sweep

**Packages:** `forge-optimizer`, `middleware-feedback-loop`, `forge-policy`

**What the user does:** Uses forged tools throughout a session, then session ends, optimizer evaluates.

### Steps

```
Step 1: Create and use a tool multiple times (from earlier scenarios)
  Multiple POST /admin/api/agents/:id/chat with tool usage

Step 2: Check health tracking
  GET /admin/api/view/forge/bricks

  Expected: bricks have fitness data (successCount, errorCount)

Step 3: End the session (terminate agent)
  POST /admin/api/cmd/agents/:id/terminate

  This triggers onSessionEnd → optimizer sweep runs

Step 4: Check forge events after sweep
  GET /admin/api/view/forge/events

  Expected: optimizer events (brick_promoted, brick_deprecated, or none if insufficient data)

Step 5: Check brick states
  GET /admin/api/view/forge/bricks

  Expected: lifecycle may have changed based on optimizer decisions
```

---

## Execution Order

Run scenarios in this order (each builds on previous state):

1. **Scenario 1** — Create a tool (establishes baseline brick in store)
2. **Scenario 5** — Name dedup (tests the #1081 fix)
3. **Scenario 2** — Capability gap (tests demand detector model scanning)
4. **Scenario 3** — Repeated failure (tests demand detector tool tracking)
5. **Scenario 4** — Promote/demote/quarantine via admin commands
6. **Scenario 6** — SSE event verification (monitors during operations)
7. **Scenario 7** — Session end → optimizer sweep

## Pass Criteria

| Scenario | Pass if |
|----------|---------|
| 1 | Brick appears in `/view/forge/bricks` with correct name + lifecycle |
| 2 | `demand_detected` event with `capability_gap` in `/view/forge/events` |
| 3 | `demand_detected` event with `repeated_failure` after 3 exec failures |
| 4 | Brick lifecycle changes via promote/demote/quarantine commands |
| 5 | Second `forge_tool` call for same name returns `forgesConsumed: 0` |
| 6 | SSE stream contains forge events during operations |
| 7 | Optimizer events appear after agent termination |

## Fail Criteria

- Any `unknown error` from model calls (governance bug — fixed in this PR)
- Nexus 429 rate limiting (should not happen with single-agent session)
- Brick not found in Nexus after forge_tool succeeds
- SSE stream drops events silently
