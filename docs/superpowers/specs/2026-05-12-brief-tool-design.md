# `brief` tool — scheduled digest delivery

> Issue #1195 follow-up. Closes the last named-but-unbuilt tool surface in `@koi/proactive` (sleep, cron, monitor, notify already landed).

## Goal

Provide a tool that lets an agent register a recurring digest: "every Monday 9am, summarize <topic> over <window>, deliver to <channel>." The agent receives the wake at fire time and synthesizes + notifies in its own turn. The tool itself does not call the LLM.

## Architecture

Agent-wake (monitor pattern). At fire time, the scheduler dispatches a structured wake text. The agent's normal loop reads the text, synthesizes via the LLM, and uses the existing `notify` tool to deliver. `brief` itself is thin: register/list/update/cancel cron schedules with a brief-specific wake-message format.

Brief is a parallel surface to `monitor` — not a generalization of it — because their semantics differ:
- `monitor`: "check periodically, alert if something needs action"
- `brief`: "always synthesize and deliver, regardless of state"

Overloading monitor with a `delivery_intent` would create a hidden two-mode contract.

## Tech Stack

- TypeScript 6 strict; ESM with `.js` extensions
- bun:test
- zod for arg validation, mirror monitor's `toJSONSchema` pattern
- Reuses `@koi/scheduler` via `SchedulerComponent` (same as monitor)

## Contract

```ts
create_brief({
  name: string,            // human-readable, e.g. "weekly-status"
  topic: string,           // free-form ("open PRs and CI failures")
  window: string,          // free-form ("last 7 days")
  channel: string,         // adapter name; validated only if resolveChannel is configured
  expression: string,      // cron expression understood by croner
  timezone?: string,       // IANA, e.g. "America/Los_Angeles"
  context_hint?: string,   // optional extra hint forwarded to wake text
  idempotency_key?: string,
}) →
  | { ok: true, brief_id: string, schedule_id: string }
  | { ok: true, brief_id: string, schedule_id: string, deduped: true }
  | { ok: false, error: string }

list_briefs({}) → { ok: true, briefs: ReadonlyArray<{
  brief_id, schedule_id, name, topic, window, channel,
  expression, timezone?, context_hint?
}> }

update_brief({
  brief_id, name?, topic?, window?, channel?, expression?, timezone?, context_hint?
}) →
  | { ok: true, brief_id, schedule_id }
  | { ok: false, error: "unknown brief_id" | "scheduler-error" }

cancel_brief({ brief_id }) → { ok: true, removed: boolean }
```

### Wake message format

When the scheduler fires, it dispatches an `EngineInput` with kind=`text` and:

```
Brief: <name>
Topic: <topic>
Window: <window>
Deliver to: <channel>
Context: <context_hint>     (omitted when context_hint is absent)

Synthesize a concise digest covering the topic over the window.
Use the notify tool to deliver the digest to the channel above.
```

Rendered by `formatBriefWakeMessage()`. Deterministic — required for snapshot tests.

### Idempotency semantics (parity with monitor)

- `idempotency_key` is process-local (a `Map<key, brief_id>` in `BriefToolState`).
- Reuse with identical fields returns `deduped: true` and the existing `brief_id`/`schedule_id`.
- Reuse with differing fields returns `ok: false, error`. Agent must `cancel_brief` first or use a new key.

## File Structure

| File | Responsibility |
|---|---|
| `packages/lib/proactive/src/brief-tools.ts` (NEW, ~500 lines) | 4 factory functions + state + wake-message formatter, mirroring `monitor-tools.ts` |
| `packages/lib/proactive/src/brief-tools.test.ts` (NEW) | Unit coverage |
| `packages/lib/proactive/src/create-proactive-tools.ts` (MOD) | Wire 4 brief tools into `assembleProactiveTools`; thread `BriefToolState` through `ProactiveToolStates` |
| `packages/lib/proactive/src/index.ts` (MOD) | Re-export public API |
| `packages/lib/proactive/src/__tests__/integration.test.ts` (MOD) | End-to-end fire-and-dispatch tests |
| `docs/L2/proactive.md` (MOD) | Add brief tool section |
| `docs/L3/runtime.md` (MOD) | Changelog entry |
| `packages/meta/runtime/src/__tests__/golden-replay.test.ts` (MOD) | Tool count 8→12 and names list |
| `package.json` + `.github/workflows/ci.yml` (MOD) | Complexity ratchet bump if exceeded |

## State & lifecycle (parity with monitor)

`BriefToolState`:
```ts
interface BriefToolState {
  readonly records: Map<BriefId, BriefRecord>;
  readonly idempotency: Map<string, BriefId>;
  readonly reservations: Map<string, true>;  // in-flight create
}
```

**Create**:
1. Reserve idempotency_key (if provided)
2. Schedule cron via scheduler.submit
3. On success: store record, clear reservation
4. On failure: clear reservation, return `{ok:false, error}`

**Update**:
1. Look up brief by id; fail if unknown
2. Build replacement schedule (retire old, submit new)
3. If new submit fails: re-submit old to restore (compensation)
4. If retire reports false / throws: log + degrade, keep new schedule

**Cancel**:
1. Find record; if absent return `{ok:true, removed:false}`
2. Unschedule (best-effort)
3. Drop record + idempotency entry
4. Second call returns `removed:false`, no duplicate unschedule

## Channel validation

Optional. If `resolveChannel` is threaded into the brief tool config (same shape used by `notify`), `create_brief` rejects unknown channel names pre-schedule. If not threaded, channel is trusted (agent's responsibility).

Recommendation: thread it through — caller already supplies `resolveChannel` for notify; brief should validate consistently. Keeps "fail fast at create time, not at fire time" semantics.

## Tests

Unit (`brief-tools.test.ts`):
1. create stores record + schedules cron + list returns it
2. create dedupes on identical idempotency_key (same fields → deduped)
3. create rejects reused key with differing fields
4. create cleans reservation on scheduler error
5. create validates required fields before touching scheduler
6. list returns sorted/structured records, no leakage
7. update rotates schedule (retire + create new schedule_id)
8. update fails on unknown brief_id
9. update patch semantics (omitted fields preserved)
10. update compensates when new schedule fails (re-create old)
11. update compensates when retire reports false / throws
12. cancel removes state + unschedules
13. cancel idempotent (twice = ok, second `removed:false`, no duplicate unschedule)
14. cancel unknown brief_id → `removed:false`
15. `formatBriefWakeMessage` deterministic multi-line with all fields
16. `formatBriefWakeMessage` omits Context line when absent
17. channel validation: unknown channel rejected pre-schedule when `resolveChannel` configured

Integration (`__tests__/integration.test.ts`):
18. brief schedule fires → dispatcher receives the exact expected wake text
19. update brief rotates the live schedule and later dispatches only the new text
20. cancel brief suppresses future fires

## Out of scope

- LLM call at fire time (agent does it in its own turn after wake)
- Autonomous delivery without agent loop (rejected; tracked as potential future enhancement)
- Persistent state across process restarts (process-local, same as monitor — durability is a separate concern tracked by checkpoint store)
- Built-in templates or formatters for the digest body (agent chooses)
