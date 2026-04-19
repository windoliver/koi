# Model Picker — Design (2026-04-18)

## Problem

Today `/model` is a read-only info notice (`tui-command.ts:3254`). To change model the user must edit `.env` or the manifest and restart the TUI. Other agents let the user fuzzy-pick and swap models mid-session without restart.

## Goals

1. User can open a picker mid-session, fuzzy-filter a live list of provider models, select one, and have every subsequent turn use the new model.
2. The switch is **this-session-only** — it does not write back to `.env` / manifest and does not affect new `koi tui` launches.
3. Works for any provider whose `/models` endpoint follows the OpenAI / OpenRouter shape (`{ data: [{ id, ... }] }`). Degrades gracefully for providers that don't.
4. Discoverable: slash command, Ctrl shortcut, and command-palette entry.

## Non-goals

- Per-agent model switching (spawned sub-agents keep their configured model).
- Reasoning toggle UI — `supportsReasoning` stays tied to provider at startup.
- Persisting the switch to `.env` / manifest.
- Pricing comparisons beyond whatever the `/models` endpoint returns verbatim.
- Offline / cached model catalog — fetch happens on picker open.

## User flow

1. User triggers the picker via **Ctrl+M**, `/model <query>`, or command palette → `Switch model`.
2. Modal opens with a loading state while the fetch is in flight (in-session-cached after first open).
3. Model list renders: one row per model showing `id · context_window · input_price / output_price` when available.
4. Typing filters with the existing fuzzy-match helpers; Up/Down navigate; Enter selects.
5. On select: modal closes, an inline notice appears — `[Model switched: anthropic/claude-sonnet-4-6 → anthropic/claude-opus-4-7]`. Next turn uses the new model.
6. On Esc: modal closes, no change.
7. On fetch failure: picker shows `{error}\nEdit KOI_MODEL in .env to switch manually.` and blocks selection.

## Architecture

### Switch mechanism — "current-model" middleware

A small middleware wraps the `modelStream` handler. It holds a shared mutable box `{ current: string }` initialised to the startup model name. Before dispatching to the next handler, it rewrites `request.model = box.current`.

The adapter (`model-openai-compat/src/adapter.ts:342`) already respects `request.model`:

```ts
const effectiveModel = request.model ?? config.model;
```

So `box.current` is authoritative for the next call without reconstructing the adapter, engine, or middleware chain. The TUI dispatcher and picker share the same box reference.

Rationale: smallest possible surface. No L0 change, no engine change, no adapter change. The middleware is an L2 concern local to the CLI wiring.

### Model list fetch

New file `packages/meta/cli/src/model-list-fetch.ts`:

- `fetchAvailableModels(provider, baseUrl, apiKey)` → `Promise<Result<readonly ModelEntry[], string>>`.
- URL resolution: `${baseUrl ?? providerDefaultUrl(provider)}/models`. Default URLs: `https://openrouter.ai/api/v1`, `https://api.openai.com/v1`, etc.
- Auth header: `Authorization: Bearer ${apiKey}`.
- Parse `{ data: [{ id, context_length?, pricing?: { prompt?, completion? } }] }`. Tolerate missing fields.
- Timeout: 8s. On timeout / non-2xx / parse error → typed error string surfaced to UI.

In-session cache keyed by `${provider}:${baseUrl ?? ""}` so reopening the picker is instant.

### State

`TuiState.modal` gets a new discriminated variant:

```ts
{
  kind: "model-picker";
  query: string;
  status: "loading" | "ready" | "error";
  models: readonly ModelEntry[];  // empty while loading
  error?: string;                  // set when status === "error"
  currentModel: string;            // shown with a "*" marker
}
```

New reducer actions:

- `set_modal: { kind: "model-picker", ... }` — existing shape, reuses current dispatcher.
- `model_picker_set_query: { query: string }` — updates filter text.
- `model_picker_fetched: { models | error }` — called when the async fetch resolves.
- `model_switched: { model: string }` — sets `state.modelName` so the status bar re-renders. No mutation of `cumulativeMetrics`.

`TuiState` gets a new top-level field `modelName: string`, initialised from the startup model name. The status bar (`StatusBar.tsx`) reads this field instead of the current prop-passed value. No change to `cumulativeMetrics` or session persistence.

### UI

New component `packages/ui/tui/src/components/ModelPicker.tsx`. Mirrors `SessionPicker` structure:

- Header row: `Models — select to switch · Esc to cancel`.
- Loading state: spinner row.
- Empty-filter state: full list; with query, fuzzy-filtered via `fuzzyMatch`.
- Error state: single text block with the error + manual-edit hint.
- Rows: `{id}  {context}  {$in/$out}`. Current model gets a leading `*`.

Keyboard: Up/Down (or Ctrl+N/Ctrl+P) navigate, Enter select, any printable char types into query, Backspace deletes from query, Esc dismiss.

### Triggers

`packages/ui/tui/src/commands/command-definitions.ts` gains:

```ts
{ id: "system:model-switch", label: "Switch model",
  description: "Pick a model to use for the rest of this session",
  category: "system", ctrlShortcut: "M" }
```

The existing `system:model` (read-only info) stays — users who type `/model` with no args get the current behaviour.

`packages/ui/tui/src/key-event.ts` gains `isCtrlM`. `keyboard.ts` gains an `onOpenModelPicker` callback in `GlobalKeyCallbacks` and an `isCtrlM` branch guarded identically to `isCtrlS` (modal null, conversation view, no slash/@ overlay).

`packages/meta/cli/src/tui-command.ts` slash dispatch:

- `/model` alone → today's info notice (unchanged).
- `/model <query>` → open picker with `query` prefilled.
- `system:model-switch` command id → open picker empty.

### Files touched

| File | Change | Approx LoC |
|------|--------|------------|
| `packages/ui/tui/src/key-event.ts` + test | add `isCtrlM` | +10 |
| `packages/ui/tui/src/keyboard.ts` + test | add `onOpenModelPicker` + guarded dispatch | +30 |
| `packages/ui/tui/src/state/types.ts` | new modal variant + actions | +20 |
| `packages/ui/tui/src/state/reduce.ts` + test | handlers for new actions | +50 |
| `packages/ui/tui/src/commands/command-definitions.ts` | `system:model-switch` | +8 |
| `packages/ui/tui/src/components/ModelPicker.tsx` + test | new component | +220 |
| `packages/ui/tui/src/components/HelpView.tsx` | `Ctrl+M Switch model` | +1 |
| `packages/ui/tui/src/tui-root.tsx` | wire modal + callback + fetch kickoff | +35 |
| `packages/meta/cli/src/model-list-fetch.ts` + test | new module | +120 |
| `packages/meta/cli/src/tui-command.ts` | middleware box + slash handler + switch path | +80 |

Estimated total: **~+575 LoC** on top of the current Ctrl+S PR. Above the 300-line guideline; call out in the PR description and split if review asks.

## Testing

- `model-list-fetch.test.ts`: mocked fetch; happy path (OpenRouter + OpenAI shapes), 404, timeout, auth failure, malformed JSON.
- `keyboard.test.ts`: Ctrl+M opens picker under the same guards as Ctrl+S.
- `reduce.test.ts`: modal open, query update, fetched-ok, fetched-error, model_switched.
- `ModelPicker.test.tsx`: loading → ready, fuzzy filter, Enter dispatches `model_switched`, Esc dismisses.
- `tui-command` slash-dispatch test: `/model` (info) vs `/model query` (picker with prefilled query) vs `system:model-switch` (picker empty).
- No golden-query change — middleware only rewrites an optional request field that adapters already honour; cassette replay keeps working because tests never set `KOI_MODEL` via the picker.

## Error handling

- Fetch timeout / non-2xx → surfaced in modal, no switch happens.
- Selected model that the provider rejects at call time → engine surfaces the provider error as usual; the box keeps the new value (user's choice) so they can correct it manually on the next open.
- Concurrent switches (rapid Enter) → last dispatch wins; no race because the box is a single mutable ref.

## Security

- Model id is echoed into a request body only; no shell exec, no file write.
- Fetch uses the existing API key; no new credential surface.
- No unbounded memory: in-session cache is keyed per provider+baseUrl, max a few hundred rows.

## Out of scope — follow-ups

- Persisting the switch to `.env` with a confirmation dialog.
- Per-agent model switching via manifest overrides.
- Pricing comparison display vs. current model.
- Offline catalog snapshot so the picker works without network.
