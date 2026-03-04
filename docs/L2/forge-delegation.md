# Forge External Delegation

Forge delegation lets an agent ask an external coding agent (Claude Code, Codex, Aider)
to write the implementation for a new brick, then verifies the result through the full
forge pipeline before accepting it.

---

## What it enables

Without delegation, the agent calling `forge_tool` must write the `implementation` string
itself. This works for simple tools (`"return input.a + input.b;"`) but falls apart for
anything that needs real coding — file parsing, API integrations, complex algorithms.

With delegation, the agent describes **what** it needs and a coding agent writes **how**:

```
Before:  Agent writes implementation itself
         forge_tool({ name: "csv_parser", implementation: "..." })
         → Agent must be good at coding

After:   Agent delegates to a coding agent
         forge_tool({ name: "csv_parser", delegateTo: "claude-code", testCases: [...] })
         → Claude Code writes the implementation
         → Forge verifies it in sandbox
         → Agent gets a working, tested tool
```

The agent focuses on **what tool it needs and how to test it**. The coding agent focuses
on **writing correct code**. Forge ensures **the code is safe**.

---

## How it works

### 1. Agent calls forge_tool with `delegateTo`

```typescript
forge_tool({
  name: "csv_parser",
  description: "Parses CSV strings into arrays of objects",
  inputSchema: {
    type: "object",
    properties: { csv: { type: "string" } },
  },
  delegateTo: "claude-code",
  delegateOptions: { timeoutMs: 60000, retries: 1 },
  testCases: [
    { name: "basic", input: { csv: "a,b\n1,2" }, expectedOutput: [{ a: "1", b: "2" }] },
  ],
})
```

`implementation` is optional when `delegateTo` is set.

### 2. Forge discovers the agent

Calls `ForgeDeps.discoverAgent("claude-code")` — returns an `ExternalAgentDescriptor`
with the agent's name, command, transport, and capabilities.

Returns `AGENT_NOT_FOUND` error if the agent isn't available on this machine.

### 3. Forge generates a coding prompt

`generateDelegationPrompt()` builds a structured prompt from the forge input:

- Tool name and description
- Input schema (JSON Schema)
- Test cases with expected outputs
- Output schema (if provided)

The coding agent receives everything it needs to write a correct implementation.

### 4. Forge spawns the coding agent

Calls `ForgeDeps.spawnCodingAgent()` with the agent descriptor, prompt, and options.
Retry loop handles transient failures — configurable via `delegateOptions.retries`.

### 5. Implementation enters the verification pipeline

The coding agent's output replaces the `implementation` field, then goes through the
standard 6-stage forge pipeline:

1. **Static analysis** — validates structure, name, schema
2. **Format** — auto-formats the code
3. **Resolve** — installs npm dependencies in a cached workspace
4. **Sandbox execution** — runs the code in an isolated subprocess
5. **Self-test** — runs test cases against the implementation
6. **Trust scoring** — assigns trust tier based on verification results

If any stage fails, the brick is rejected — regardless of what the coding agent claimed.

---

## Dependency injection

Delegation uses two optional callbacks on `ForgeDeps`:

```typescript
interface ForgeDeps {
  // ... existing fields ...

  /** Discovers an external coding agent by name. Injected by L3 consumer. */
  readonly discoverAgent?: (
    name: string,
  ) => Promise<Result<ExternalAgentDescriptor, KoiError>>;

  /** Spawns an external coding agent to produce implementation code. */
  readonly spawnCodingAgent?: (
    agent: ExternalAgentDescriptor,
    prompt: string,
    options: DelegateOptions,
  ) => Promise<Result<string, KoiError>>;
}
```

When these callbacks are absent, `delegateTo` returns a clear error. Forge works
exactly as before — no behavior change for existing callers.

The L3 consumer wires these via `createForgeDelegation()` — see
[Forge Delegation Wiring (L3)](../L3/forge-delegation.md) for the composition root
that connects `@koi/agent-discovery` and `@koi/agent-spawner` to these callbacks.

---

## Error handling

Delegation has its own error stage with four codes:

| Code | When |
|------|------|
| `AGENT_NOT_FOUND` | `discoverAgent` can't find the named agent |
| `DELEGATION_TIMEOUT` | Coding agent didn't respond within `timeoutMs` |
| `DELEGATION_FAILED` | Coding agent returned an error (crash, bad output) |
| `DELEGATION_RETRIES_EXHAUSTED` | All retry attempts failed |

These are separate from verification errors — the agent knows whether delegation
failed (fix the agent setup) or verification failed (the code was bad).

---

## Options

```typescript
interface DelegateOptions {
  /** Model to use for the coding agent (e.g., "opus"). */
  readonly model?: string;
  /** Timeout per attempt in milliseconds. Default: 120,000 (2 min). */
  readonly timeoutMs?: number;
  /** Number of retries after failure. Default: 0 (no retries). */
  readonly retries?: number;
}
```

Delegation timeout is independent from the verification pipeline timeout.
Each retry gets its own full timeout budget.

---

## Security model

The delegation feature separates **authoring** from **verification**:

- The coding agent is an **untrusted author** — it produces code
- Forge is the **trusted verifier** — it checks the code independently
- The coding agent's claims about its output are never trusted
- All code goes through sandbox execution + adversarial verification

The coding agent now runs inside a sandbox container (Docker/E2B) via
`@koi/agent-spawner` — see [Forge Delegation Wiring (L3)](../L3/forge-delegation.md).

---

## Files

| File | What |
|------|------|
| `tools/delegate.ts` | `generateDelegationPrompt()` + `delegateImplementation()` |
| `tools/delegate.test.ts` | 13 unit tests covering all error paths and retry logic |
| `tools/shared.ts` | `DelegateOptions`, `ForgeDeps` callbacks, `ParsedToolInput.delegateTo` |
| `tools/forge-tool.ts` | Handler integration — calls delegation before pipeline |
| `errors.ts` | `delegation` error stage + `delegationError()` factory |
| `forge-error-adapter.ts` | Maps delegation errors to KoiError codes |

---

## Related issues

- **#501** — This feature (forge delegation plumbing)
- **#744** — Sandboxed agent spawning, structured response, companion skill
