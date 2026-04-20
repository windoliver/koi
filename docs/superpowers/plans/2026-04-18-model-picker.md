# Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user open a picker mid-session, fuzzy-filter a live list of provider models, pick one, and have every subsequent turn use the new model — no TUI restart.

**Architecture:** The adapter already honours `request.model` per call. A "current-model" middleware holds a mutable `{ current: string }` box and rewrites `request.model` before dispatch. The picker UI is a new modal that mirrors `SessionPicker`, fetches models on open via `{baseUrl}/models`, and dispatches `model_switched` to update the box and status bar.

**Tech Stack:** TypeScript 6, Bun, SolidJS (TUI), OpenTUI, existing `fuzzyFilter` helper, `bun:test` for tests.

---

## File Structure

**New files:**
- `packages/meta/cli/src/model-list-fetch.ts` — provider `/models` fetch + typed result
- `packages/meta/cli/src/model-list-fetch.test.ts` — unit tests
- `packages/meta/cli/src/current-model-middleware.ts` — model-override middleware + mutable box
- `packages/meta/cli/src/current-model-middleware.test.ts` — unit tests
- `packages/ui/tui/src/components/ModelPicker.tsx` — picker modal component
- `packages/ui/tui/src/components/ModelPicker.test.ts` — unit tests

**Modified files:**
- `packages/ui/tui/src/state/types.ts` — add `modelName`, add `model-picker` modal variant, add action kinds
- `packages/ui/tui/src/state/initial.ts` — seed `modelName` from startup (call site wires this)
- `packages/ui/tui/src/state/reduce.ts` — handle new actions
- `packages/ui/tui/src/state/reduce.test.ts` — coverage for new handlers
- `packages/ui/tui/src/key-event.ts` — add `isCtrlM`
- `packages/ui/tui/src/key-event.test.ts` — test `isCtrlM`
- `packages/ui/tui/src/keyboard.ts` — add `onOpenModelPicker` + Ctrl+M branch
- `packages/ui/tui/src/keyboard.test.ts` — guard tests
- `packages/ui/tui/src/commands/command-definitions.ts` — `system:model-switch`
- `packages/ui/tui/src/components/HelpView.tsx` — `Ctrl+M Switch model`
- `packages/ui/tui/src/components/StatusBar.tsx` — read `modelName` from store
- `packages/ui/tui/src/tui-root.tsx` — mount ModelPicker + wire callbacks
- `packages/meta/cli/src/tui-command.ts` — slash branch + middleware wiring

---

## Task 1: Add `modelName` field + `model-picker` modal variant + actions to state types

**Files:**
- Modify: `packages/ui/tui/src/state/types.ts`

- [ ] **Step 1: Locate current modal variants**

Read `packages/ui/tui/src/state/types.ts` to find the `Modal` union type and the `TuiAction` union. Locate `TuiState` to find where top-level fields live.

- [ ] **Step 2: Add `ModelEntry` type, new `Modal` variant, and action kinds**

In `packages/ui/tui/src/state/types.ts`, add after the last existing `Modal` variant (inside the discriminated union):

```ts
| {
    readonly kind: "model-picker";
    readonly query: string;
    readonly status: "loading" | "ready" | "error";
    readonly models: readonly ModelEntry[];
    readonly error?: string;
  }
```

Add the `ModelEntry` type near the other modal-adjacent types:

```ts
export interface ModelEntry {
  readonly id: string;
  readonly contextLength?: number;
  readonly pricingIn?: number;
  readonly pricingOut?: number;
}
```

Add `readonly modelName: string;` to `TuiState`.

Add to the `TuiAction` union:

```ts
| { readonly kind: "model_picker_set_query"; readonly query: string }
| {
    readonly kind: "model_picker_fetched";
    readonly result:
      | { readonly ok: true; readonly models: readonly ModelEntry[] }
      | { readonly ok: false; readonly error: string };
  }
| { readonly kind: "model_switched"; readonly model: string }
```

- [ ] **Step 3: Update `createInitialState` call signature to accept startup model**

Read `packages/ui/tui/src/state/initial.ts`. Change the signature to take a `modelName: string` parameter (with default `""` for test callers that don't care) and include it in the returned state.

```ts
export function createInitialState(modelName = ""): TuiState {
  return {
    // ... existing fields
    modelName,
  };
}
```

- [ ] **Step 4: Run typecheck to find call-site breakage**

```bash
bun run typecheck
```

Expected: errors at every `createInitialState()` caller that now needs to handle the new field, plus anywhere `TuiState` is destructured. Some test files call `createInitialState()` without args — those stay valid because of the default.

- [ ] **Step 5: Fix typecheck fallout — only fix type errors, no behavior changes**

Add `modelName: ""` explicitly to any test fixture that builds a `TuiState` literal (search for `TuiState = {` or `satisfies TuiState`). Do not touch production callers — Task 9 wires them with the real model name.

- [ ] **Step 6: Run typecheck again**

```bash
bun run typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/ui/tui/src/state/types.ts packages/ui/tui/src/state/initial.ts packages/ui/tui/src/state/*.test.ts packages/ui/tui/src/state/**/*.test.ts
git commit -m "feat(tui): state types for model picker"
```

---

## Task 2: Reducer handlers for new actions

**Files:**
- Modify: `packages/ui/tui/src/state/reduce.ts`
- Test: `packages/ui/tui/src/state/reduce.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/ui/tui/src/state/reduce.test.ts` (use the existing file's helpers):

```ts
describe("reduce — model picker actions", () => {
  test("model_picker_set_query updates query in open picker", () => {
    const state: TuiState = {
      ...createInitialState("anthropic/claude-sonnet-4-6"),
      modal: { kind: "model-picker", query: "", status: "ready", models: [] },
    };
    const next = reduce(state, { kind: "model_picker_set_query", query: "opus" });
    expect(next.modal).toEqual({
      kind: "model-picker",
      query: "opus",
      status: "ready",
      models: [],
    });
  });

  test("model_picker_set_query is a no-op when a different modal is open", () => {
    const state: TuiState = {
      ...createInitialState(),
      modal: { kind: "command-palette", query: "" },
    };
    const next = reduce(state, { kind: "model_picker_set_query", query: "opus" });
    expect(next).toBe(state);
  });

  test("model_picker_fetched ok populates models and flips to ready", () => {
    const state: TuiState = {
      ...createInitialState(),
      modal: { kind: "model-picker", query: "", status: "loading", models: [] },
    };
    const models = [{ id: "anthropic/claude-opus-4-7" }];
    const next = reduce(state, { kind: "model_picker_fetched", result: { ok: true, models } });
    expect(next.modal).toEqual({
      kind: "model-picker",
      query: "",
      status: "ready",
      models,
    });
  });

  test("model_picker_fetched error flips to error with message", () => {
    const state: TuiState = {
      ...createInitialState(),
      modal: { kind: "model-picker", query: "", status: "loading", models: [] },
    };
    const next = reduce(state, {
      kind: "model_picker_fetched",
      result: { ok: false, error: "timeout" },
    });
    expect(next.modal).toEqual({
      kind: "model-picker",
      query: "",
      status: "error",
      models: [],
      error: "timeout",
    });
  });

  test("model_switched updates state.modelName", () => {
    const state = createInitialState("anthropic/claude-sonnet-4-6");
    const next = reduce(state, {
      kind: "model_switched",
      model: "anthropic/claude-opus-4-7",
    });
    expect(next.modelName).toBe("anthropic/claude-opus-4-7");
  });
});
```

- [ ] **Step 2: Run tests and verify they fail**

```bash
cd packages/ui/tui && bun test src/state/reduce.test.ts
```

Expected: 5 failing tests — "Unhandled action: model_picker_set_query" or similar.

- [ ] **Step 3: Implement the reducer branches**

In `packages/ui/tui/src/state/reduce.ts`, add next to existing modal-related cases:

```ts
case "model_picker_set_query": {
  if (state.modal?.kind !== "model-picker") return state;
  return { ...state, modal: { ...state.modal, query: action.query } };
}

case "model_picker_fetched": {
  if (state.modal?.kind !== "model-picker") return state;
  const next = action.result.ok
    ? {
        ...state.modal,
        status: "ready" as const,
        models: action.result.models,
      }
    : {
        ...state.modal,
        status: "error" as const,
        error: action.result.error,
      };
  return { ...state, modal: next };
}

case "model_switched": {
  return { ...state, modelName: action.model };
}
```

- [ ] **Step 4: Run tests, verify green**

```bash
cd packages/ui/tui && bun test src/state/reduce.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/tui/src/state/reduce.ts packages/ui/tui/src/state/reduce.test.ts
git commit -m "feat(tui): reducer handlers for model picker actions"
```

---

## Task 3: `fetchAvailableModels` happy path

**Files:**
- Create: `packages/meta/cli/src/model-list-fetch.ts`
- Test: `packages/meta/cli/src/model-list-fetch.test.ts`

- [ ] **Step 1: Write failing test — OpenRouter shape**

```ts
// packages/meta/cli/src/model-list-fetch.test.ts
import { describe, expect, test, mock } from "bun:test";
import { fetchAvailableModels } from "./model-list-fetch.js";

describe("fetchAvailableModels", () => {
  test("parses OpenRouter {data: [{id, context_length, pricing}]} shape", async () => {
    const fetchMock = mock(async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: "anthropic/claude-opus-4-7",
              context_length: 200000,
              pricing: { prompt: "0.000015", completion: "0.000075" },
            },
            { id: "openai/gpt-5" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await fetchAvailableModels({
      provider: "openrouter",
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-test",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toEqual({
      id: "anthropic/claude-opus-4-7",
      contextLength: 200000,
      pricingIn: 0.000015,
      pricingOut: 0.000075,
    });
    expect(result.models[1]).toEqual({ id: "openai/gpt-5" });
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd packages/meta/cli && bun test src/model-list-fetch.test.ts
```

Expected: module-not-found error.

- [ ] **Step 3: Implement happy path**

```ts
// packages/meta/cli/src/model-list-fetch.ts
import type { ModelEntry } from "@koi/tui";

export interface FetchModelsOptions {
  readonly provider: string;
  readonly baseUrl?: string;
  readonly apiKey: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export type FetchModelsResult =
  | { readonly ok: true; readonly models: readonly ModelEntry[] }
  | { readonly ok: false; readonly error: string };

const PROVIDER_DEFAULT_BASE_URLS: Record<string, string> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
};

interface RawModel {
  readonly id?: unknown;
  readonly context_length?: unknown;
  readonly pricing?: { readonly prompt?: unknown; readonly completion?: unknown };
}

function parseNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function normaliseModel(raw: RawModel): ModelEntry | undefined {
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  const entry: { -readonly [K in keyof ModelEntry]: ModelEntry[K] } = { id: raw.id };
  const ctx = parseNumber(raw.context_length);
  if (ctx !== undefined) entry.contextLength = ctx;
  const pIn = parseNumber(raw.pricing?.prompt);
  if (pIn !== undefined) entry.pricingIn = pIn;
  const pOut = parseNumber(raw.pricing?.completion);
  if (pOut !== undefined) entry.pricingOut = pOut;
  return entry;
}

export async function fetchAvailableModels(
  options: FetchModelsOptions,
): Promise<FetchModelsResult> {
  const fetchFn = options.fetch ?? globalThis.fetch;
  const base = options.baseUrl ?? PROVIDER_DEFAULT_BASE_URLS[options.provider];
  if (base === undefined) {
    return { ok: false, error: `No /models endpoint known for provider "${options.provider}"` };
  }

  const url = `${base.replace(/\/$/, "")}/models`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);

  try {
    const res = await fetchFn(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${options.apiKey}` },
      signal: controller.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}: ${res.statusText}` };
    }
    const json = (await res.json()) as { data?: readonly RawModel[] };
    const raw = json.data ?? [];
    const models = raw
      .map(normaliseModel)
      .filter((m): m is ModelEntry => m !== undefined);
    return { ok: true, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 4: Run test, verify green**

```bash
cd packages/meta/cli && bun test src/model-list-fetch.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/meta/cli/src/model-list-fetch.ts packages/meta/cli/src/model-list-fetch.test.ts
git commit -m "feat(cli): fetchAvailableModels happy path"
```

---

## Task 4: `fetchAvailableModels` error paths

**Files:**
- Test: `packages/meta/cli/src/model-list-fetch.test.ts` (add tests)

- [ ] **Step 1: Write failing tests**

Append to the `describe("fetchAvailableModels", ...)` block:

```ts
test("returns error on non-2xx", async () => {
  const fetchMock = mock(async () => new Response("nope", { status: 401 }));
  const result = await fetchAvailableModels({
    provider: "openrouter",
    apiKey: "sk-bad",
    fetch: fetchMock as unknown as typeof fetch,
  });
  expect(result).toEqual({ ok: false, error: "HTTP 401: " });
});

test("returns error on abort/timeout", async () => {
  const fetchMock = mock(async (_url: string, init?: RequestInit) => {
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  });
  const result = await fetchAvailableModels({
    provider: "openrouter",
    apiKey: "sk-test",
    fetch: fetchMock as unknown as typeof fetch,
    timeoutMs: 20,
  });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toMatch(/abort/i);
});

test("returns error for unknown provider without baseUrl", async () => {
  const result = await fetchAvailableModels({
    provider: "anthropic",
    apiKey: "sk-test",
  });
  expect(result).toEqual({
    ok: false,
    error: 'No /models endpoint known for provider "anthropic"',
  });
});

test("skips malformed entries without failing", async () => {
  const fetchMock = mock(async () =>
    new Response(JSON.stringify({ data: [{ id: "" }, null, { id: "good/model" }] }), {
      status: 200,
    }),
  );
  const result = await fetchAvailableModels({
    provider: "openrouter",
    apiKey: "sk-test",
    fetch: fetchMock as unknown as typeof fetch,
  });
  expect(result).toEqual({ ok: true, models: [{ id: "good/model" }] });
});
```

- [ ] **Step 2: Run tests, verify all four fail**

```bash
cd packages/meta/cli && bun test src/model-list-fetch.test.ts
```

Expected: 4 failures from new tests (happy path still passes).

- [ ] **Step 3: Verify the existing impl handles 3 of 4 already; patch the 4th**

The happy-path implementation already handles non-2xx (HTTP status branch), abort (catch), and unknown provider (early return). Only "skips malformed entries" needs tightening — the `normaliseModel` + filter already covers `{id: ""}` (empty string) and `null` (type-guard on `typeof raw.id !== "string"`). Re-run tests; if any still fail, inspect and fix.

- [ ] **Step 4: Run tests, verify all green**

```bash
cd packages/meta/cli && bun test src/model-list-fetch.test.ts
```

Expected: 5 pass (1 existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add packages/meta/cli/src/model-list-fetch.test.ts
git commit -m "test(cli): fetchAvailableModels error coverage"
```

---

## Task 5: `isCtrlM` predicate

**Files:**
- Modify: `packages/ui/tui/src/key-event.ts`
- Modify: `packages/ui/tui/src/key-event.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `packages/ui/tui/src/key-event.test.ts` import list: `isCtrlM`.

Append new describe block:

```ts
describe("isCtrlM", () => {
  test("true for ctrl+m", () => {
    expect(isCtrlM(key("m", { ctrl: true }))).toBe(true);
  });
  test("false for plain m", () => {
    expect(isCtrlM(key("m"))).toBe(false);
  });
  test("false for ctrl+n", () => {
    expect(isCtrlM(key("n", { ctrl: true }))).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd packages/ui/tui && bun test src/key-event.test.ts
```

Expected: `Export named 'isCtrlM' not found`.

- [ ] **Step 3: Implement**

In `packages/ui/tui/src/key-event.ts`, add after `isCtrlS`:

```ts
export function isCtrlM(key: KeyEvent): boolean {
  return key.ctrl && key.name === "m";
}
```

- [ ] **Step 4: Run test, verify green**

```bash
cd packages/ui/tui && bun test src/key-event.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/tui/src/key-event.ts packages/ui/tui/src/key-event.test.ts
git commit -m "feat(tui): isCtrlM key predicate"
```

---

## Task 6: Ctrl+M dispatch branch with guards

**Files:**
- Modify: `packages/ui/tui/src/keyboard.ts`
- Modify: `packages/ui/tui/src/keyboard.test.ts`

- [ ] **Step 1: Write failing tests**

Add `onOpenModelPicker: mock(() => {})` to `makeCallbacks()`.

Add a new describe block mirroring the Ctrl+S block:

```ts
describe("handleGlobalKey — Ctrl+M", () => {
  test("calls onOpenModelPicker on conversation view with no modal", () => {
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("m", { ctrl: true }), stateNoModal, cbs);
    expect(result).toBe(true);
    expect(cbs.onOpenModelPicker).toHaveBeenCalledTimes(1);
  });
  test("ignored when a modal is open", () => {
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("m", { ctrl: true }), stateWithModal, cbs);
    expect(result).toBe(false);
    expect(cbs.onOpenModelPicker).not.toHaveBeenCalled();
  });
  test("ignored on non-conversation views", () => {
    const state: TuiState = { ...createInitialState(), activeView: "trajectory" };
    const cbs = makeCallbacks();
    const result = handleGlobalKey(key("m", { ctrl: true }), state, cbs);
    expect(result).toBe(false);
  });
  test("ignored when slash overlay is active", () => {
    const state: TuiState = { ...createInitialState(), slashQuery: "mod" };
    const cbs = makeCallbacks();
    expect(handleGlobalKey(key("m", { ctrl: true }), state, cbs)).toBe(false);
  });
  test("ignored when @-mention overlay is active", () => {
    const state: TuiState = { ...createInitialState(), atQuery: "src/" };
    const cbs = makeCallbacks();
    expect(handleGlobalKey(key("m", { ctrl: true }), state, cbs)).toBe(false);
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
cd packages/ui/tui && bun test src/keyboard.test.ts
```

Expected: type error (onOpenModelPicker missing from `GlobalKeyCallbacks`) plus behaviour failures.

- [ ] **Step 3: Implement**

In `packages/ui/tui/src/keyboard.ts`, add to `GlobalKeyCallbacks`:

```ts
/** Open the model picker (Ctrl+M). */
readonly onOpenModelPicker: () => void;
```

Import `isCtrlM`:

```ts
import { isCtrlC, isCtrlM, isCtrlN, isCtrlP, isCtrlS, isEscape } from "./key-event.js";
```

Add a branch immediately after the Ctrl+S branch:

```ts
// Ctrl+M — open model picker (same guards as Ctrl+S)
if (
  isCtrlM(event) &&
  state.modal === null &&
  state.activeView === "conversation" &&
  state.slashQuery === null &&
  state.atQuery === null
) {
  callbacks.onOpenModelPicker();
  return true;
}
```

- [ ] **Step 4: Run tests, verify green**

```bash
cd packages/ui/tui && bun test src/keyboard.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/tui/src/keyboard.ts packages/ui/tui/src/keyboard.test.ts
git commit -m "feat(tui): Ctrl+M dispatch branch for model picker"
```

---

## Task 7: `system:model-switch` command definition + HelpView row

**Files:**
- Modify: `packages/ui/tui/src/commands/command-definitions.ts`
- Modify: `packages/ui/tui/src/components/HelpView.tsx`

- [ ] **Step 1: Add command entry**

In `packages/ui/tui/src/commands/command-definitions.ts`, add next to `system:model`:

```ts
{
  id: "system:model-switch",
  label: "Switch model",
  description: "Pick a model to use for the rest of this session",
  category: "system",
  ctrlShortcut: "M",
},
```

- [ ] **Step 2: Add HelpView row**

In `packages/ui/tui/src/components/HelpView.tsx`, extend `KEYBINDINGS`:

```ts
const KEYBINDINGS = [
  { key: "Ctrl+P", action: "Open command palette" },
  { key: "Ctrl+N", action: "Start a new session" },
  { key: "Ctrl+S", action: "Open sessions picker" },
  { key: "Ctrl+M", action: "Switch model" },
  { key: "Ctrl+C", action: "Interrupt agent" },
  { key: "Esc", action: "Dismiss modal · back to conversation" },
  { key: "Enter", action: "Submit message" },
  { key: "Ctrl+J", action: "Insert newline in message" },
] as const;
```

- [ ] **Step 3: Commit**

```bash
git add packages/ui/tui/src/commands/command-definitions.ts packages/ui/tui/src/components/HelpView.tsx
git commit -m "feat(tui): register Switch model command + help row"
```

---

## Task 8: current-model middleware + mutable box

**Files:**
- Create: `packages/meta/cli/src/current-model-middleware.ts`
- Create: `packages/meta/cli/src/current-model-middleware.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/meta/cli/src/current-model-middleware.test.ts
import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelStreamHandler } from "@koi/core";
import { createCurrentModelMiddleware } from "./current-model-middleware.js";

function emptyRequest(): ModelRequest {
  return { messages: [] };
}

describe("current-model middleware", () => {
  test("rewrites request.model to box.current before calling next", async () => {
    const { middleware, box } = createCurrentModelMiddleware("anthropic/claude-sonnet-4-6");
    let seenModel: string | undefined;
    const next: ModelStreamHandler = async function* (req) {
      seenModel = req.model;
      yield { kind: "done", output: { content: "", metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 1, durationMs: 0 } } } as never;
    };
    const mw = middleware({ session: { sessionId: "s" } } as never);
    if (mw.modelStream === undefined) throw new Error("expected modelStream wrapper");
    const stream = mw.modelStream(emptyRequest(), next);
    for await (const _ of stream) { /* drain */ }
    expect(seenModel).toBe("anthropic/claude-sonnet-4-6");

    box.current = "anthropic/claude-opus-4-7";
    const stream2 = mw.modelStream(emptyRequest(), next);
    for await (const _ of stream2) { /* drain */ }
    expect(seenModel).toBe("anthropic/claude-opus-4-7");
  });
});
```

- [ ] **Step 2: Run test, verify module-not-found failure**

```bash
cd packages/meta/cli && bun test src/current-model-middleware.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement**

```ts
// packages/meta/cli/src/current-model-middleware.ts
import type { KoiMiddleware, ModelRequest, ModelStreamHandler } from "@koi/core";

export interface CurrentModelBox {
  current: string;
}

export interface CurrentModelMiddleware {
  readonly middleware: KoiMiddleware;
  readonly box: CurrentModelBox;
}

export function createCurrentModelMiddleware(
  initialModel: string,
): CurrentModelMiddleware {
  const box: CurrentModelBox = { current: initialModel };
  const middleware: KoiMiddleware = () => ({
    id: "current-model",
    modelStream: (request: ModelRequest, next: ModelStreamHandler) => {
      const rewritten: ModelRequest = { ...request, model: box.current };
      return next(rewritten);
    },
  });
  return { middleware, box };
}
```

- [ ] **Step 4: Run test, verify green**

```bash
cd packages/meta/cli && bun test src/current-model-middleware.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/meta/cli/src/current-model-middleware.ts packages/meta/cli/src/current-model-middleware.test.ts
git commit -m "feat(cli): current-model middleware with mutable box"
```

---

## Task 9: ModelPicker component

**Files:**
- Create: `packages/ui/tui/src/components/ModelPicker.tsx`
- Create: `packages/ui/tui/src/components/ModelPicker.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// packages/ui/tui/src/components/ModelPicker.test.ts
import { describe, expect, test } from "bun:test";
import { filterModels, formatModelRow } from "./ModelPicker.js";

describe("filterModels", () => {
  const models = [
    { id: "anthropic/claude-sonnet-4-6", contextLength: 200000 },
    { id: "anthropic/claude-opus-4-7" },
    { id: "openai/gpt-5" },
  ];

  test("empty query returns all models unchanged", () => {
    expect(filterModels(models, "")).toEqual(models);
  });

  test("filters by substring subsequence (fuzzy)", () => {
    const result = filterModels(models, "opus");
    expect(result.map((m) => m.id)).toEqual(["anthropic/claude-opus-4-7"]);
  });

  test("returns empty when nothing matches", () => {
    expect(filterModels(models, "zzz")).toEqual([]);
  });
});

describe("formatModelRow", () => {
  test("shows id only when no metadata", () => {
    expect(formatModelRow({ id: "openai/gpt-5" })).toBe("openai/gpt-5");
  });
  test("includes context length when present", () => {
    expect(
      formatModelRow({ id: "anthropic/claude-opus-4-7", contextLength: 200000 }),
    ).toBe("anthropic/claude-opus-4-7  ·  200k ctx");
  });
  test("includes pricing when present", () => {
    expect(
      formatModelRow({
        id: "anthropic/claude-opus-4-7",
        contextLength: 200000,
        pricingIn: 0.000015,
        pricingOut: 0.000075,
      }),
    ).toBe("anthropic/claude-opus-4-7  ·  200k ctx  ·  $15/$75 per 1M");
  });
});
```

- [ ] **Step 2: Run test, verify failure**

```bash
cd packages/ui/tui && bun test src/components/ModelPicker.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement**

```tsx
// packages/ui/tui/src/components/ModelPicker.tsx
import type { JSX } from "solid-js";
import { fuzzyFilter } from "../commands/fuzzy-match.js";
import { useTuiStore } from "../store-context.js";
import type { ModelEntry } from "../state/types.js";
import { COLORS, MODAL_POSITION } from "../theme.js";
import { SelectOverlay } from "./SelectOverlay.js";

export interface ModelPickerProps {
  readonly onSelect: (model: ModelEntry) => void;
  readonly onClose: () => void;
  readonly focused: boolean;
}

export function filterModels(
  models: readonly ModelEntry[],
  query: string,
): readonly ModelEntry[] {
  return fuzzyFilter(models, query, (m) => m.id);
}

export function formatModelRow(m: ModelEntry): string {
  const parts: string[] = [m.id];
  if (m.contextLength !== undefined) {
    parts.push(`${Math.round(m.contextLength / 1000)}k ctx`);
  }
  if (m.pricingIn !== undefined && m.pricingOut !== undefined) {
    const inM = Math.round(m.pricingIn * 1_000_000);
    const outM = Math.round(m.pricingOut * 1_000_000);
    parts.push(`$${inM}/$${outM} per 1M`);
  }
  return parts.join("  ·  ");
}

export function ModelPicker(props: ModelPickerProps): JSX.Element {
  const modal = useTuiStore((s) => s.modal);
  const currentModel = useTuiStore((s) => s.modelName);

  const resolveModal = (): {
    query: string;
    status: "loading" | "ready" | "error";
    models: readonly ModelEntry[];
    error?: string;
  } => {
    const m = modal();
    if (m?.kind !== "model-picker") {
      return { query: "", status: "loading", models: [] };
    }
    return m;
  };

  return (
    <box
      flexDirection="column"
      border={true}
      borderColor={COLORS.purple}
      width={90}
      {...MODAL_POSITION}
    >
      <box paddingLeft={1} paddingTop={1} paddingBottom={1}>
        <text fg={COLORS.purple}>
          <b>{"Models"}</b>
        </text>
        <text fg={COLORS.textMuted}>{"  — select to switch, Esc to cancel"}</text>
      </box>

      {resolveModal().status === "loading" ? (
        <text fg={COLORS.textMuted}>{"  loading…"}</text>
      ) : resolveModal().status === "error" ? (
        <box flexDirection="column" paddingLeft={1}>
          <text fg={COLORS.red}>{resolveModal().error ?? "Failed to fetch models"}</text>
          <text fg={COLORS.textMuted}>{"Edit KOI_MODEL in .env to switch manually."}</text>
        </box>
      ) : (
        <SelectOverlay
          items={filterModels(resolveModal().models, resolveModal().query)}
          getLabel={(m: ModelEntry) =>
            m.id === currentModel() ? `* ${formatModelRow(m)}` : formatModelRow(m)
          }
          onSelect={props.onSelect}
          onClose={props.onClose}
          focused={props.focused}
          emptyText="No models matched"
        />
      )}
    </box>
  );
}
```

- [ ] **Step 4: Run test, verify green**

```bash
cd packages/ui/tui && bun test src/components/ModelPicker.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/tui/src/components/ModelPicker.tsx packages/ui/tui/src/components/ModelPicker.test.ts
git commit -m "feat(tui): ModelPicker component"
```

---

## Task 10: StatusBar reads `modelName` from store

**Files:**
- Modify: `packages/ui/tui/src/components/StatusBar.tsx`

- [ ] **Step 1: Locate existing model-name source**

Read `packages/ui/tui/src/components/StatusBar.tsx` and find where `modelName` (or the current model string) is rendered in the status line. It's likely received as a prop from `tui-root.tsx`.

- [ ] **Step 2: Switch to store read**

Replace the prop read with:

```ts
const modelName = useTuiStore((s) => s.modelName);
```

Render `{modelName()}` (Solid signal) in place of the old prop.

- [ ] **Step 3: Update caller in `tui-root.tsx` to stop passing the prop (if it was a prop)**

Remove the `modelName={...}` JSX attribute from the `<StatusBar />` site. Leave other props.

- [ ] **Step 4: Run typecheck + tui tests**

```bash
bun run typecheck
cd packages/ui/tui && bun test
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/tui/src/components/StatusBar.tsx packages/ui/tui/src/tui-root.tsx
git commit -m "refactor(tui): StatusBar reads modelName from store"
```

---

## Task 11: Wire picker in `tui-root.tsx`

**Files:**
- Modify: `packages/ui/tui/src/tui-root.tsx`

- [ ] **Step 1: Add `onOpenModelPicker` callback to `handleGlobalKey` call**

Locate the existing `handleGlobalKey(event, store.getState(), { ... })` call in `tui-root.tsx`. Add:

```ts
onOpenModelPicker: () => {
  const cmd = COMMAND_DEFINITIONS.find((c) => c.id === "system:model-switch");
  if (cmd !== undefined) handleCommandSelect(cmd);
},
```

- [ ] **Step 2: Add `system:model-switch` routing to `handleCommandSelect`**

Locate the existing `if (cmd.id === "session:sessions") { openSessionPicker(); return; }` branch. Add next to it:

```ts
if (cmd.id === "system:model-switch") {
  openModelPicker("");
  return;
}
```

- [ ] **Step 3: Add `openModelPicker` helper + fetch kickoff**

In `tui-root.tsx`, near `openSessionPicker`, add:

```ts
const modelListCache = new Map<string, Promise<FetchModelsResult>>();

const openModelPicker = (initialQuery: string): void => {
  store.dispatch({
    kind: "set_modal",
    modal: { kind: "model-picker", query: initialQuery, status: "loading", models: [] },
  });
  const cacheKey = `${props.provider}:${props.baseUrl ?? ""}`;
  let pending = modelListCache.get(cacheKey);
  if (pending === undefined) {
    pending = fetchAvailableModels({
      provider: props.provider,
      baseUrl: props.baseUrl,
      apiKey: props.apiKey,
    });
    modelListCache.set(cacheKey, pending);
  }
  void pending.then((result) => {
    store.dispatch({ kind: "model_picker_fetched", result });
  });
};
```

Import `FetchModelsResult` and `fetchAvailableModels` from `@koi-agent/cli` or wherever the CLI package re-exports it. If not re-exported, change `packages/meta/cli/src/index.ts` to re-export `model-list-fetch`.

- [ ] **Step 4: Add modal render branch**

In the modal-render switch inside `tui-root.tsx`, add:

```tsx
{modal()?.kind === "model-picker" && (
  <ModelPicker
    focused={true}
    onSelect={(m) => {
      props.onModelSwitch(m.id);
      store.dispatch({ kind: "model_switched", model: m.id });
      store.dispatch({ kind: "set_modal", modal: null });
      dispatchNotice(store, "model-switched", `[Model switched to ${m.id}]`);
    }}
    onClose={() => store.dispatch({ kind: "set_modal", modal: null })}
  />
)}
```

Add `onModelSwitch: (model: string) => void` to the `TuiRootProps` interface (with other callbacks) and `apiKey`, `baseUrl?: string`, `provider: string` if not already present. Update any callers accordingly — the single caller is `tui-command.ts` (Task 12 wires it).

- [ ] **Step 4.5: Add slash dispatch branch for `/model <query>`**

Find the slash-command handler in `tui-root.tsx` (or wherever slash text is parsed into command dispatch). Where `/model` currently maps to `system:model`, add:

```ts
if (command === "model" && args.trim().length > 0) {
  openModelPicker(args.trim());
  return;
}
```

Bare `/model` continues to dispatch `system:model` for the info notice.

- [ ] **Step 5: Typecheck + tui tests**

```bash
bun run typecheck
cd packages/ui/tui && bun test
```

Expected: clean. Any test failures are usually because `TuiRoot` test harnesses need the new required props — add defaults.

- [ ] **Step 6: Commit**

```bash
git add packages/ui/tui/src/tui-root.tsx packages/meta/cli/src/index.ts
git commit -m "feat(tui): wire model picker modal + slash + palette paths"
```

---

## Task 12: Wire middleware + callback in `tui-command.ts`

**Files:**
- Modify: `packages/meta/cli/src/tui-command.ts`

- [ ] **Step 1: Construct the middleware and get the box handle**

Near the existing middleware-chain construction in `tui-command.ts` (grep for `createAuditMiddleware` or wherever other middleware is added), insert:

```ts
const { middleware: currentModelMiddleware, box: currentModelBox } =
  createCurrentModelMiddleware(modelName);
```

Add `currentModelMiddleware` to the middleware chain in the correct position — **before** any adapter-sensitive middleware, but inside the composition (it needs to wrap `modelStream`). Match the pattern of existing additions; the exact call site is identified by reading the surrounding code.

- [ ] **Step 2: Import statement**

Add to the top of `tui-command.ts`:

```ts
import { createCurrentModelMiddleware } from "./current-model-middleware.js";
```

- [ ] **Step 3: Pass the switch callback + config props to `TuiRoot`**

Where `TuiRoot` is rendered, add:

```tsx
<TuiRoot
  // ... existing props
  provider={provider}
  baseUrl={baseUrl}
  apiKey={apiKey}
  onModelSwitch={(model) => {
    currentModelBox.current = model;
  }}
/>
```

- [ ] **Step 4: Run typecheck + tests**

```bash
bun run typecheck
bun run test --filter=@koi/tui --filter=@koi-agent/cli
```

Expected: clean.

- [ ] **Step 5: Full build**

```bash
bun run build
```

Expected: success.

- [ ] **Step 6: Commit**

```bash
git add packages/meta/cli/src/tui-command.ts
git commit -m "feat(cli): wire current-model middleware + switch callback"
```

---

## Task 13: Live validation via tmux

**Files:** none (validation only)

- [ ] **Step 1: Launch TUI in a worktree-scoped tmux session**

```bash
WORKTREE=$(basename "$PWD")
SESSION="${WORKTREE}-model-picker"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -x 140 -y 45 "bun run packages/meta/cli/src/bin.ts tui; sleep 900"
sleep 10
tmux capture-pane -t "$SESSION" -p | tail -3
```

Expected: `Type a message... (/ for commands)`

- [ ] **Step 2: Verify `Ctrl+M` opens the picker with loading state**

```bash
tmux send-keys -t "$SESSION" C-m
sleep 1
tmux capture-pane -t "$SESSION" -p | head -15
```

Expected: `Models  — select to switch, Esc to cancel` and a `loading…` line.

- [ ] **Step 3: Wait for fetch to complete and capture**

```bash
sleep 5
tmux capture-pane -t "$SESSION" -p | head -20
```

Expected: list of model ids (at least `anthropic/claude-sonnet-4-6`, `anthropic/claude-opus-4-7`, `openai/gpt-5`, etc.). Current model prefixed with `*`.

- [ ] **Step 4: Verify fuzzy filter via typing**

```bash
tmux send-keys -t "$SESSION" "opus"
sleep 1
tmux capture-pane -t "$SESSION" -p | grep -E "opus|claude" | head -3
```

Expected: filtered to Opus entries.

- [ ] **Step 5: Switch to a different model and verify a model call uses it**

```bash
tmux send-keys -t "$SESSION" Enter   # select current highlighted
sleep 2
tmux capture-pane -t "$SESSION" -p | grep -iE "Model switched" | head -1
tmux capture-pane -t "$SESSION" -p | head -1   # status bar shows new model
tmux send-keys -t "$SESSION" "say hi in one word" Enter
sleep 20
tmux capture-pane -t "$SESSION" -p | head -1
```

Expected: `[Model switched to <new-model>]` notice + status bar reflects the new model + turn completes (status bar shows `up X down Y`).

- [ ] **Step 6: Verify `/model` alone still shows info (no picker)**

```bash
tmux send-keys -t "$SESSION" Escape
sleep 1
tmux send-keys -t "$SESSION" "/model" Enter
sleep 2
tmux capture-pane -t "$SESSION" -p | grep -E "Model:" | head -1
```

Expected: `[Model: <current-model> · Provider: <provider>]` notice (not a picker).

- [ ] **Step 7: Verify `/model <query>` opens picker with query prefilled**

```bash
tmux send-keys -t "$SESSION" Escape
sleep 1
tmux send-keys -t "$SESSION" "/model sonnet" Enter
sleep 5
tmux capture-pane -t "$SESSION" -p | head -15
```

Expected: picker open, rows filtered to `sonnet`.

- [ ] **Step 8: Cleanup**

```bash
tmux kill-session -t "$SESSION"
```

- [ ] **Step 9: If any step fails**

Stop, diagnose, fix, rebuild, retry from the failing step. Do not commit or continue to the next task until live verification is green end-to-end.

---

## Task 14: Scrub PR description and push

**Files:** none (VCS only)

- [ ] **Step 1: Verify all tests + typecheck + build**

```bash
bun run typecheck
bun run test
bun run build
```

Expected: all green.

- [ ] **Step 2: Extend the open PR's description**

Use `gh pr edit 1902 --body "$(cat <<'EOF' ... EOF)"` to replace the PR body with an updated summary that includes both the Ctrl+S fix and the model picker feature. No references to external products. Mention the +LoC delta and cite the spec file + plan file in `docs/superpowers/`.

- [ ] **Step 3: Push**

```bash
git push
```

Expected: push succeeds; the existing PR #1902 reflects the new commits.

---

## Self-Review Checklist

- [x] Every spec requirement has a task
- [x] No `TODO`, `TBD`, "fill in details" placeholders
- [x] Types/names consistent across tasks: `ModelEntry`, `modelName`, `onOpenModelPicker`, `system:model-switch`, `model_picker_set_query`, `model_picker_fetched`, `model_switched`, `currentModelBox`, `fetchAvailableModels`
- [x] Each step has either commands or code (no "similar to…")
- [x] TDD discipline: failing test → verify → minimal code → verify green → commit
- [x] Live validation step before merging
- [x] External product references scrubbed
