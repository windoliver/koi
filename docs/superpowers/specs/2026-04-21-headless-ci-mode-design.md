# Headless CI Mode — Design Spec

**Issue:** #1648  
**Date:** 2026-04-21  
**Status:** Approved for implementation  
**Branch:** `feat/headless-ci-mode`

---

## Context

Koi's headless mode (`koi start --headless`) is already substantially implemented:

- `--headless` flag disables TUI, routes all output to NDJSON on stdout
- NDJSON event stream: `session_start` → `assistant_text` / `tool_call` / `tool_result` → `result`
- All 6 exit codes (0–5) implemented and tested in `headless/exit-codes.ts`
- `--allow-tool` whitelist for permission auto-deny/allow
- `--max-duration-ms`, `--max-turns`, `--max-spend` budget enforcement
- Bootstrap + post-run deadline timers, SIGINT handling, tool payload redaction

**Remaining for #1648 closure (3 items):**
1. `--result-schema <file>` — JSON Schema validation of assistant output
2. `docs/guides/headless-mode.md` — user-facing guide
3. GitHub Actions workflow example (embedded in guide)

---

## 1. `--result-schema <file>`

### Flag definition

Added to `args/start.ts` alongside `--headless`:

```
--result-schema <path>    Path to a JSON Schema file. Validates the agent's
                          text output is valid JSON matching the schema.
                          Headless-only. Exit 1 on validation failure.
```

**Parse-time constraint:** `--result-schema` without `--headless` is a `ParseError`. Consistent with `--allow-tool` and `--max-duration-ms`.

**Type in `StartFlags`:**
```typescript
readonly resultSchema: string | undefined;
```

### Boot-time validation (commands/start.ts)

During setup phase (same phase as `--policy-file` loading):

1. Read file at `flags.resultSchema` path
2. `JSON.parse()` the contents
3. Validate it is a JSON Schema object (has `type: "object"` or `properties` key at root)
4. On any failure → `bail("result-schema rejected: <reason>", 5)` — exit 5 (INTERNAL) because this is operator misconfiguration, not agent failure

The parsed schema object is stored in a local variable and passed into the post-run validation step.

### Post-run validation (commands/start.ts, headless branch)

After `runHeadless()` returns, before calling `emitResult()`:

1. Collect all `assistant_text` events emitted during the run (tracked via a string accumulator in the headless branch)
2. Attempt `JSON.parse(accumulatedText)` — if it fails → `emitResult({ exitCode: 1, error: "schema validation failed: assistant output is not valid JSON" })`
3. Run parsed value against the schema via `validateSchema()` — if it fails → `emitResult({ exitCode: 1, error: "schema validation failed: <path> <violation>" })`
4. On success → normal `emitResult()` with the run's exit code unchanged

**Important:** Schema validation runs AFTER `shutdownRuntime()` because `emitResult` must be called after teardown. If `shutdownFailed` is true, skip schema validation and emit the INTERNAL result as normal (teardown failure takes precedence).

### Minimal JSON Schema validator — `headless/validate-schema.ts`

New file, ~40 lines, zero new dependencies. Covers the 90% CI use case:

- `type` — `"object"`, `"array"`, `"string"`, `"number"`, `"boolean"`, `"null"`
- `required` — array of required property names
- `properties` — recursive validation of named properties
- `enum` — value must be one of the listed literals

Returns `{ ok: true }` or `{ ok: false; path: string; message: string }`.

**Explicit non-goals:** `$ref`, `anyOf`/`oneOf`/`allOf`, `pattern`, `format`, `if/then/else`. These can be added later if CI use cases demand them. For now, a clear error message ("unsupported keyword: $ref") is emitted rather than silently ignoring unsupported keywords.

### Assistant text accumulation

The headless branch in `commands/start.ts` currently calls `runHeadless()` and gets back `{ exitCode, emitResult }`. The assistant text is emitted inside `runHeadless()` as NDJSON but not returned.

To accumulate without touching `runHeadless()` internals, `writeStdout` is wrapped:

```typescript
const assistantTextParts: string[] = [];
const wrappedWriteStdout = (chunk: string): void => {
  process.stdout.write(chunk);
  // Extract assistant_text deltas from NDJSON for schema validation
  tryExtractAssistantText(chunk, assistantTextParts);
};
```

`tryExtractAssistantText` parses each NDJSON line and pushes `event.text` when `event.kind === "assistant_text"`. Parsing failures are silently ignored (the write already happened; schema validation will fail on the accumulated empty/partial text).

This keeps `runHeadless()` unchanged and avoids threading schema concerns into the event loop.

---

## 2. `docs/guides/headless-mode.md`

Single Markdown file. Sections:

1. **Overview** — what headless mode is, when to use it
2. **Quick start** — minimal working invocation
3. **Flags reference** — all headless-relevant flags with types, defaults, constraints
4. **Exit codes** — table of 0–5 with meaning and retry guidance
5. **NDJSON event reference** — all event kinds with field descriptions
6. **Security defaults** — what's off by default (MCP, plugins, middleware, hooks, transcript) and the env-var opt-ins
7. **Result schema validation** — `--result-schema` usage with example schema
8. **CI recipes** — GitHub Actions workflow (see §3)

---

## 3. GitHub Actions workflow (embedded in guide)

YAML code block inside `docs/guides/headless-mode.md`. Shows:

```yaml
- name: Run Koi agent
  id: koi
  run: |
    koi start --headless \
      --prompt "Summarize open PRs as JSON with fields: count, titles" \
      --allow-tool web_fetch \
      --max-turns 10 \
      --max-duration-ms 120000 \
      --result-schema .koi/pr-summary-schema.json \
      > koi-output.ndjson
  continue-on-error: true

- name: Check exit code
  run: |
    RESULT=$(grep '"kind":"result"' koi-output.ndjson | tail -1)
    EXIT=$(echo "$RESULT" | jq -r '.exitCode')
    echo "koi exit: $EXIT"
    test "$EXIT" = "0"
```

Companion schema file `.koi/pr-summary-schema.json` shown in the guide:

```json
{
  "type": "object",
  "required": ["count", "titles"],
  "properties": {
    "count": { "type": "number" },
    "titles": { "type": "array" }
  }
}
```

---

## Files changed

| File | Change |
|------|--------|
| `packages/meta/cli/src/args/start.ts` | Add `resultSchema: string \| undefined` to `StartFlags`, add `--result-schema` flag, parse-time guard |
| `packages/meta/cli/src/args/start.test.ts` | Tests for `--result-schema` parse rules |
| `packages/meta/cli/src/headless/validate-schema.ts` | New: minimal JSON Schema validator |
| `packages/meta/cli/src/headless/validate-schema.test.ts` | New: validator unit tests |
| `packages/meta/cli/src/commands/start.ts` | Boot-time schema load, `wrappedWriteStdout` accumulator, post-run validation |
| `packages/meta/cli/src/commands/start.test.ts` | Tests for schema validation paths |
| `docs/guides/headless-mode.md` | New: user guide + GitHub Actions recipe |

---

## Testing plan

| Scenario | Expected |
|----------|----------|
| `--result-schema` without `--headless` | `ParseError` at parse time |
| Schema file not found | exit 5, `result-schema rejected: ENOENT` |
| Schema file is invalid JSON | exit 5, `result-schema rejected: invalid JSON` |
| Agent output is not JSON | exit 1, `schema validation failed: assistant output is not valid JSON` |
| Agent output is JSON but fails schema | exit 1, `schema validation failed: .titles is required` |
| Agent output matches schema | exit 0, normal result |
| `shutdownFailed` + valid schema | exit 5 (teardown takes precedence) |

All tests use `bun:test` mocks — no live LLM or filesystem required.
