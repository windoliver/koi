# Governance TUI bridge

> Host owns the bridge; TUI is render-only. The implementation pattern mirrors `packages/meta/cli/src/cost-bridge.ts` — read that source if you need a worked example.

## Inputs (subscriptions)

The bridge subscribes to `@koi/governance-core` callbacks:

- `onAlert(pct, variable, reading)` → dispatch `add_governance_alert`
- `onViolation(verdict, request)` → dispatch `add_governance_violation`
- After every engine `done` event (same hook as `cost-bridge.recordEngineDone`),
  call `controller.snapshot()` and dispatch `set_governance_snapshot`.

## Outputs (TUI actions)

- `set_governance_snapshot { snapshot: GovernanceSnapshot }`
- `add_governance_alert { alert: GovernanceAlert }`
- `add_governance_violation { violation: GovernanceViolation }`
- `clear_governance_alerts` (fired by `/governance reset`)
- `set_governance_rules { rules: readonly RuleDescriptor[] }` — once at startup
- `set_governance_capabilities { capabilities: readonly CapabilityFragmentLite[] }` — once at startup. `CapabilityFragmentLite` is a TUI-local `{ label, description }` type — the bridge maps the L1 `CapabilityFragment` returned by `mw.describeCapabilities(ctx)` to this lighter shape so the TUI never imports L1 types (layering rule).

## Persistence

Append-only JSONL at `~/.koi/governance-alerts.jsonl`. Each line:

```json
{"ts":1745000000,"sessionId":"…","variable":"cost_usd","threshold":0.8,"current":1.6,"limit":2.0,"utilization":0.8}
```

Tail-evict to last 200 lines on bridge startup. On `/governance` open, the TUI
already has alerts in-memory for the current session; persisted alerts seed
the "Recent alerts" section.

## Error handling

- Alert-write failure → `console.warn`, never throw. Bridge must not block
  governance-core flow.
- Snapshot poll failure → log + skip; previous snapshot stays in store.
- Backend `describeRules` failure → log + omit rules section.

## Lifecycle

- Created in `tui-command.ts` after `createCostBridge`.
- `dispose()` closes the JSONL writer and unsubscribes.
