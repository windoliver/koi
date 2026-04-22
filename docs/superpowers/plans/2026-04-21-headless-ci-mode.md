# Headless CI Mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the 3 remaining acceptance criteria for issue #1648: add `--result-schema` JSON Schema validation of agent output, write `docs/guides/headless-mode.md`, and add a GitHub Actions workflow example.

**Architecture:** A new pure-logic module `headless/validate-schema.ts` handles JSON Schema validation. `args/start.ts` gets the `--result-schema` flag (headless-only). `commands/start.ts` loads the schema at boot and wraps `writeStdout` to accumulate `assistant_text` deltas, then validates after `shutdownRuntime()` returns, before calling `emitResult()`. The guide is a standalone Markdown file.

**Tech Stack:** TypeScript 6 strict, Bun 1.3.x, `bun:test`, no new dependencies.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `packages/meta/cli/src/headless/validate-schema.ts` | **Create** | Minimal JSON Schema validator (type/required/properties/enum) |
| `packages/meta/cli/src/headless/validate-schema.test.ts` | **Create** | Unit tests for validator |
| `packages/meta/cli/src/args/start.ts` | **Modify** | Add `resultSchema` field + `--result-schema` flag + parse-time guard |
| `packages/meta/cli/src/args/start.test.ts` | **Modify** | Tests for `--result-schema` parse rules |
| `packages/meta/cli/src/commands/start.ts` | **Modify** | Boot schema load, stdout wrapper, post-run validation |
| `docs/guides/headless-mode.md` | **Create** | User guide + GitHub Actions recipe |

All work is in the worktree at:
`/Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode`

---

## Task 1: Minimal JSON Schema Validator

**Files:**
- Create: `packages/meta/cli/src/headless/validate-schema.ts`
- Create: `packages/meta/cli/src/headless/validate-schema.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/meta/cli/src/headless/validate-schema.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { validateLoadedSchema, validateResultSchema, validateSchema } from "./validate-schema.js";

describe("validateLoadedSchema — shape checks", () => {
  test("accepts a plain object with known keyword", () => {
    const result = validateLoadedSchema({ type: "object" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.schema).toEqual({ type: "object" });
  });

  test("rejects null", () => {
    const result = validateLoadedSchema(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("JSON object");
  });

  test("rejects array", () => {
    const result = validateLoadedSchema([]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("JSON object");
  });

  test("rejects schema with unsupported keyword $ref at boot", () => {
    const result = validateLoadedSchema({ $ref: "#/definitions/Foo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("$ref");
  });

  test("rejects schema where type is not a recognized string", () => {
    const result = validateLoadedSchema({ type: "integer" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("integer");
  });

  test("rejects schema where type is an array instead of string", () => {
    const result = validateLoadedSchema({ type: ["string", "null"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("type");
  });

  test("rejects schema where enum is not an array", () => {
    const result = validateLoadedSchema({ enum: "open" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("enum");
  });

  test("rejects schema where enum contains non-scalar values (objects)", () => {
    const result = validateLoadedSchema({ enum: [{ status: "open" }, "closed"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("scalar");
  });

  test("rejects schema where required is not an array of strings", () => {
    const result = validateLoadedSchema({ required: "count" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("required");
  });

  test("rejects schema where properties is not an object", () => {
    const result = validateLoadedSchema({ properties: ["count"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("properties");
  });

  test("rejects nested schema with unsupported keyword", () => {
    const result = validateLoadedSchema({
      type: "object",
      properties: { id: { $ref: "#/definitions/Id" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("$ref");
  });
});

describe("validateSchema — type", () => {
  test("passes when type matches", () => {
    expect(validateSchema("hello", { type: "string" }).ok).toBe(true);
    expect(validateSchema(42, { type: "number" }).ok).toBe(true);
    expect(validateSchema(true, { type: "boolean" }).ok).toBe(true);
    expect(validateSchema(null, { type: "null" }).ok).toBe(true);
    expect(validateSchema([], { type: "array" }).ok).toBe(true);
    expect(validateSchema({}, { type: "object" }).ok).toBe(true);
  });

  test("fails when type mismatches with path info", () => {
    const result = validateSchema("hello", { type: "number" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("number");
      expect(result.message).toContain("string");
    }
  });

  test("fails closed when type value is invalid (not a recognized string)", () => {
    const result = validateSchema("hello", { type: "integer" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("invalid schema");
  });
});

describe("validateSchema — required", () => {
  test("passes when required fields are present", () => {
    expect(
      validateSchema({ count: 1, titles: [] }, { type: "object", required: ["count", "titles"] }).ok,
    ).toBe(true);
  });

  test("fails with path when required field is missing", () => {
    const result = validateSchema({ count: 1 }, { type: "object", required: ["count", "titles"] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.path).toBe("titles");
      expect(result.message).toContain("required");
    }
  });

  test("fails closed when required is not an array", () => {
    const result = validateSchema({ count: 1 }, { required: "count" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("invalid schema");
  });

  test("fails when required is present but value is not an object (string)", () => {
    const result = validateSchema("oops", { required: ["count"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("expected object");
  });

  test("fails when required is present but value is not an object (array)", () => {
    const result = validateSchema([], { required: ["count"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("expected object");
  });
});

describe("validateSchema — properties", () => {
  test("validates nested property types recursively", () => {
    const schema = {
      type: "object",
      properties: { count: { type: "number" }, name: { type: "string" } },
    };
    expect(validateSchema({ count: 5, name: "foo" }, schema).ok).toBe(true);
  });

  test("fails with dotted path for nested type mismatch", () => {
    const schema = { type: "object", properties: { count: { type: "number" } } };
    const result = validateSchema({ count: "not-a-number" }, schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.path).toBe("count");
  });

  test("skips validation for absent optional properties", () => {
    const schema = { type: "object", properties: { count: { type: "number" } } };
    expect(validateSchema({}, schema).ok).toBe(true);
  });

  test("fails closed when properties is not an object", () => {
    const result = validateSchema({}, { properties: ["count"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("invalid schema");
  });

  test("fails when properties is present but value is not an object (string)", () => {
    const result = validateSchema("oops", { properties: { count: { type: "number" } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("expected object");
  });
});

describe("validateSchema — enum", () => {
  test("passes when value is in enum", () => {
    expect(validateSchema("open", { enum: ["open", "closed"] }).ok).toBe(true);
  });

  test("fails when value is not in enum", () => {
    const result = validateSchema("pending", { enum: ["open", "closed"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("open");
  });

  test("fails closed when enum is not an array", () => {
    const result = validateSchema("open", { enum: "open" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("invalid schema");
  });
});

describe("validateSchema — unsupported keywords", () => {
  test("rejects schemas with unsupported keywords", () => {
    const result = validateSchema({}, { $ref: "#/definitions/Foo" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("unsupported schema keyword: $ref");
  });
});

describe("validateSchema — no schema constraints", () => {
  test("empty schema passes any value", () => {
    expect(validateSchema("anything", {}).ok).toBe(true);
    expect(validateSchema(42, {}).ok).toBe(true);
  });
});

describe("validateResultSchema", () => {
  const schema = {
    type: "object",
    required: ["count", "titles"],
    properties: {
      count: { type: "number" },
      titles: { type: "array" },
    },
  } as const;

  test("returns ok when output is valid JSON matching schema", () => {
    const result = validateResultSchema('{"count":3,"titles":["a","b","c"]}', schema);
    expect(result.ok).toBe(true);
  });

  test("returns error when output is not valid JSON", () => {
    const result = validateResultSchema("not json", schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  test("returns error when output is valid JSON but missing required field", () => {
    const result = validateResultSchema('{"count":3}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("schema validation failed");
      expect(result.error).toContain("titles");
    }
  });

  test("returns error when output is valid JSON but wrong type for field", () => {
    const result = validateResultSchema('{"count":"three","titles":[]}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("count");
  });

  test("teardown-failure precedence: returns ok so caller can emit its own INTERNAL result", () => {
    // validateResultSchema is only called when shutdownFailed is false.
    // This documents the contract: the caller (commands/start.ts) is responsible
    // for skipping schema validation when shutdownFailed=true.
    const result = validateResultSchema('{"count":3,"titles":[]}', schema);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun test packages/meta/cli/src/headless/validate-schema.test.ts 2>&1 | tail -10
```

Expected: errors like `Cannot find module './validate-schema.js'`

- [ ] **Step 3: Implement validate-schema.ts**

Create `packages/meta/cli/src/headless/validate-schema.ts`:

```typescript
export type SchemaValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly path: string; readonly message: string };

const SUPPORTED_KEYWORDS = new Set(["type", "required", "properties", "enum"]);

const VALUE_TYPES = new Set(["object", "array", "string", "number", "boolean", "null"]);

/**
 * Validate the structure of a JSON Schema object itself (not a value against
 * the schema). Walks the schema tree and rejects unsupported keywords and
 * malformed keyword values so operators get a boot-time exit 5 rather than a
 * silent fail-open gate at run time.
 */
function validateSchemaStructure(
  schema: unknown,
  path: string,
): { readonly ok: true } | { readonly ok: false; readonly message: string } {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return { ok: false, message: `schema at ${path || "root"} must be an object` };
  }
  const s = schema as Record<string, unknown>;

  for (const key of Object.keys(s)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      return {
        ok: false,
        message: `unsupported schema keyword at ${path || "root"}: ${key}`,
      };
    }
  }

  if ("type" in s) {
    if (typeof s.type !== "string" || !VALUE_TYPES.has(s.type)) {
      return {
        ok: false,
        message: `schema.type at ${path || "root"} must be one of: ${[...VALUE_TYPES].join(", ")}`,
      };
    }
  }

  if ("enum" in s) {
    if (!Array.isArray(s.enum)) {
      return { ok: false, message: `schema.enum at ${path || "root"} must be an array` };
    }
    // Restrict to scalar values — composite values (objects/arrays) can't be
    // matched reliably because Array.includes uses referential equality, and
    // JSON.parse always produces new object references.
    for (const entry of s.enum as unknown[]) {
      if (entry !== null && typeof entry === "object") {
        return {
          ok: false,
          message: `schema.enum at ${path || "root"} must contain only scalar values (string, number, boolean, null); objects and arrays are not supported`,
        };
      }
    }
  }

  if ("required" in s) {
    if (
      !Array.isArray(s.required) ||
      !(s.required as unknown[]).every((k) => typeof k === "string")
    ) {
      return {
        ok: false,
        message: `schema.required at ${path || "root"} must be an array of strings`,
      };
    }
  }

  if ("properties" in s) {
    if (
      typeof s.properties !== "object" ||
      s.properties === null ||
      Array.isArray(s.properties)
    ) {
      return {
        ok: false,
        message: `schema.properties at ${path || "root"} must be an object`,
      };
    }
    for (const [key, value] of Object.entries(s.properties as Record<string, unknown>)) {
      const subPath = path ? `${path}.properties.${key}` : `properties.${key}`;
      const result = validateSchemaStructure(value, subPath);
      if (!result.ok) return result;
    }
  }

  return { ok: true };
}

/**
 * Parse a raw JSON-parsed value as a schema. Rejects non-objects, unsupported
 * keywords, and malformed keyword values. Call at boot time so operator
 * misconfiguration surfaces as exit 5 before any agent work is done.
 */
export function validateLoadedSchema(
  raw: unknown,
): { readonly ok: true; readonly schema: Record<string, unknown> } | { readonly ok: false; readonly message: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, message: "schema must be a JSON object at the root" };
  }
  const structure = validateSchemaStructure(raw, "");
  if (!structure.ok) return { ok: false, message: structure.message };
  return { ok: true, schema: raw as Record<string, unknown> };
}

/**
 * Validate a value against a JSON Schema. Fail closed on malformed keyword
 * values — if the schema itself is invalid (e.g. type: "integer"), returns an
 * error rather than silently skipping the constraint.
 *
 * Supported keywords: type, required, properties, enum.
 * Unsupported keywords cause an immediate error.
 */
export function validateSchema(
  value: unknown,
  schema: unknown,
  path = "",
): SchemaValidationResult {
  if (typeof schema !== "object" || schema === null) {
    return { ok: false, path, message: "schema must be an object" };
  }
  const s = schema as Record<string, unknown>;

  for (const key of Object.keys(s)) {
    if (!SUPPORTED_KEYWORDS.has(key)) {
      return { ok: false, path: path || ".", message: `unsupported schema keyword: ${key}` };
    }
  }

  if ("type" in s) {
    if (typeof s.type !== "string" || !VALUE_TYPES.has(s.type)) {
      return {
        ok: false,
        path: path || ".",
        message: `invalid schema: type must be one of: ${[...VALUE_TYPES].join(", ")}`,
      };
    }
    const actual = valueType(value);
    if (actual !== s.type) {
      return {
        ok: false,
        path: path || ".",
        message: `expected type ${s.type}, got ${actual}`,
      };
    }
  }

  if ("enum" in s) {
    if (!Array.isArray(s.enum)) {
      return { ok: false, path: path || ".", message: "invalid schema: enum must be an array" };
    }
    if (!s.enum.includes(value)) {
      return {
        ok: false,
        path: path || ".",
        message: `must be one of: ${s.enum.map(String).join(", ")}`,
      };
    }
  }

  if ("required" in s) {
    if (
      !Array.isArray(s.required) ||
      !(s.required as unknown[]).every((k) => typeof k === "string")
    ) {
      return {
        ok: false,
        path: path || ".",
        message: "invalid schema: required must be an array of strings",
      };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, path: path || ".", message: "expected object (schema has 'required')" };
    }
    const obj = value as Record<string, unknown>;
    for (const key of s.required as string[]) {
      if (!(key in obj)) {
        const fieldPath = path ? `${path}.${key}` : key;
        return { ok: false, path: fieldPath, message: "is required" };
      }
    }
  }

  if ("properties" in s) {
    if (
      typeof s.properties !== "object" ||
      s.properties === null ||
      Array.isArray(s.properties)
    ) {
      return {
        ok: false,
        path: path || ".",
        message: "invalid schema: properties must be an object",
      };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, path: path || ".", message: "expected object (schema has 'properties')" };
    }
    const props = s.properties as Record<string, unknown>;
    const obj = value as Record<string, unknown>;
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in obj) {
        const subPath = path ? `${path}.${key}` : key;
        const result = validateSchema(obj[key], subSchema, subPath);
        if (!result.ok) return result;
      }
    }
  }

  return { ok: true };
}

/**
 * Top-level helper used by commands/start.ts after runHeadless() returns.
 * Parses the assembled assistant text as JSON and validates it against the
 * schema. Returns a typed result so commands/start.ts can pick the right
 * exit code and error string without implementing parse/validate logic inline.
 */
export function validateResultSchema(
  assembled: string,
  schema: Record<string, unknown>,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(assembled);
  } catch {
    return { ok: false, error: "schema validation failed: assistant output is not valid JSON" };
  }
  const result = validateSchema(parsed, schema);
  if (!result.ok) {
    return {
      ok: false,
      error: `schema validation failed: ${result.path} ${result.message}`,
    };
  }
  return { ok: true };
}

function valueType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun test packages/meta/cli/src/headless/validate-schema.test.ts 2>&1 | tail -10
```

Expected: all tests pass, 0 failures.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun run typecheck --filter=@koi/cli 2>&1 | tail -5
```

Expected: `Tasks: 1 successful`

- [ ] **Step 6: Commit**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
git add packages/meta/cli/src/headless/validate-schema.ts packages/meta/cli/src/headless/validate-schema.test.ts
git commit -m "feat(headless): minimal JSON Schema validator for --result-schema (#1648)"
```

---

## Task 2: Flag Parsing — `--result-schema`

**Files:**
- Modify: `packages/meta/cli/src/args/start.ts`
- Modify: `packages/meta/cli/src/args/start.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/meta/cli/src/args/start.test.ts` (after the existing test blocks):

```typescript
describe("parseStartFlags — --result-schema (#1648)", () => {
  test("defaults to undefined when flag is absent", () => {
    const flags = parseStartFlags(["--headless", "--prompt", "hello"]);
    expect(flags.resultSchema).toBeUndefined();
  });

  test("captures the file path when flag is present", () => {
    const flags = parseStartFlags([
      "--headless",
      "--prompt",
      "hello",
      "--result-schema",
      "./schema.json",
    ]);
    expect(flags.resultSchema).toBe("./schema.json");
  });

  test("rejects --result-schema without --headless", () => {
    expect(() =>
      parseStartFlags(["--prompt", "hello", "--result-schema", "./schema.json"]),
    ).toThrow(ParseError);
  });

  test("--result-schema is allowed without --headless when --help is present", () => {
    const flags = parseStartFlags(["--result-schema", "./schema.json", "--help"]);
    expect(flags.help).toBe(true);
    expect(flags.resultSchema).toBe("./schema.json");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun test packages/meta/cli/src/args/start.test.ts 2>&1 | grep -E "fail|pass|error" | tail -10
```

Expected: failures on the new `--result-schema` tests (property undefined or unknown flag error).

- [ ] **Step 3: Add `resultSchema` to `StartFlags` and implement the flag**

In `packages/meta/cli/src/args/start.ts`, make these changes:

**a) Add field to `StartFlags` interface** (after `readonly maxDurationMs` line ~102):

```typescript
  /** Path to a JSON Schema file. Validates the agent's text output is valid JSON matching the schema. Headless-only. */
  readonly resultSchema: string | undefined;
```

**b) Add to the `V` type** (after `readonly "max-duration-ms"` line ~132):

```typescript
    readonly "result-schema": string | undefined;
```

**c) Add to the `options` object** (after `"max-duration-ms": { type: "string" }` line ~163):

```typescript
        "result-schema": { type: "string" },
```

**d) Add parse-time guard** (in the `if (!skipValidators)` block around line 285, after the `--max-duration-ms` guard):

```typescript
    if (!headless && values["result-schema"] !== undefined) {
      throw new ParseError(
        "--result-schema requires --headless: result schema validation is only meaningful in non-interactive one-shot mode",
      );
    }
```

**e) Add to return object** (after `maxDurationMs,` in the return statement ~line 349):

```typescript
    resultSchema: values["result-schema"],
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun test packages/meta/cli/src/args/start.test.ts 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun run typecheck --filter=@koi/cli 2>&1 | tail -5
```

Expected: `Tasks: 1 successful`

- [ ] **Step 6: Commit**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
git add packages/meta/cli/src/args/start.ts packages/meta/cli/src/args/start.test.ts
git commit -m "feat(headless): add --result-schema flag to parseStartFlags (#1648)"
```

---

## Task 3: Boot-Time Schema Load + Assistant Text Accumulation

**Files:**
- Modify: `packages/meta/cli/src/commands/start.ts`

- [ ] **Step 1: Add import for validate-schema**

In `packages/meta/cli/src/commands/start.ts`, add after the existing headless imports (after the `import { ... } from "../headless/run.js"` block, ~line 44):

```typescript
import { validateLoadedSchema, validateSchema } from "../headless/validate-schema.js";
```

- [ ] **Step 2: Add boot-time schema loading**

In `packages/meta/cli/src/commands/start.ts`, insert after the policy-file loading block (after line 672, the closing `}` of the policy-file `if` block):

```typescript
  // Load --result-schema at boot so a missing/malformed file fails fast
  // (exit 5 — operator misconfiguration) rather than after the agent runs.
  let resultSchemaObj: Record<string, unknown> | undefined;
  if (flags.resultSchema !== undefined) {
    try {
      const raw = await Bun.file(flags.resultSchema).text();
      const parsed: unknown = JSON.parse(raw);
      const check = validateLoadedSchema(parsed);
      if (!check.ok) {
        return bail(`result-schema rejected: ${check.message}`, 5);
      }
      resultSchemaObj = check.schema;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return bail(`result-schema rejected: ${msg}`, 5);
    }
  }
```

- [ ] **Step 3: Add `onRawAssistantText` callback to `RunHeadlessOptions` in `headless/run.ts`**

The NDJSON stream runs `assistant_text` deltas through `redactEngineBanners()` before emission to protect CI logs. Schema validation must see the **raw** text the model produced — not the redacted version — otherwise banner-shaped JSON output would be rewritten before validation, causing false failures.

In `packages/meta/cli/src/headless/run.ts`, add the optional callback to `RunHeadlessOptions` (around line 50):

```typescript
interface RunHeadlessOptions {
  readonly sessionId: string;
  readonly prompt: string;
  readonly maxDurationMs: number | undefined;
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
  readonly runtime: HeadlessRuntime;
  readonly externalSignal?: AbortSignal | undefined;
  /**
   * Called with each raw (pre-redaction) assistant text delta for callers
   * that need the unmodified model output (e.g. --result-schema validation).
   * The emitted NDJSON stream still carries the redacted version.
   */
  readonly onRawAssistantText?: ((text: string) => void) | undefined;
}
```

There are **two** emission paths for `assistant_text` in `run.ts` — both must fire the raw callback before redaction:

**Path A — `text_delta` events (streaming):** In `translateEvent`, in the `"text_delta"` case:

```typescript
    case "text_delta": {
      if (event.delta.length > 0) {
        onRawAssistantText?.(event.delta);                // raw, before redaction
        emit({ kind: "assistant_text", text: redactEngineBanners(event.delta) });
        return true;
      }
      return false;
    }
```

**Path B — `done.output.content` fallback (when no deltas were seen):** In the `done` event handler inside the `for await` loop in `runHeadless`, before the `emit` call:

```typescript
        if (!emittedAssistantText) {
          const fallback = extractTextFromContent(event.output.content);
          if (fallback.length > 0) {
            opts.onRawAssistantText?.(fallback);          // raw, before redaction
            emit({ kind: "assistant_text", text: redactEngineBanners(fallback) });
            emittedAssistantText = true;
          }
        }
```

**`translateEvent` signature change:** Pass `onRawAssistantText` as an additional parameter (minimum diff, no closure change needed):

Change from:

```typescript
function translateEvent(
  event: EngineEvent,
  emit: ReturnType<typeof createEmitter>,
  toolNamesByCallId: Map<string, string>,
): boolean {
```

to:

```typescript
function translateEvent(
  event: EngineEvent,
  emit: ReturnType<typeof createEmitter>,
  toolNamesByCallId: Map<string, string>,
  onRawAssistantText: ((text: string) => void) | undefined,
): boolean {
```

Update the call site in `runHeadless`:

```typescript
      if (translateEvent(event, emit, toolNamesByCallId, opts.onRawAssistantText)) {
```

**Also add a test to `run.test.ts`** verifying the callback fires for both paths and is not invoked with redacted text. Append to `run.test.ts`:

```typescript
describe("runHeadless — onRawAssistantText callback", () => {
  test("fires with raw delta text before redaction", async () => {
    const raw: string[] = [];
    await runAndEmit({
      events: [
        { kind: "text_delta", delta: "[Turn failed: secret-token-abc.]" },
        { kind: "done", output: { stopReason: "completed", content: [], metadata: {} } },
      ],
      onRawAssistantText: (t) => { raw.push(t); },
    });
    // The raw callback receives the unredacted string
    expect(raw.join("")).toContain("secret-token-abc");
  });

  test("fires via done.output.content fallback when no deltas were emitted", async () => {
    const raw: string[] = [];
    await runAndEmit({
      events: [
        {
          kind: "done",
          output: {
            stopReason: "completed",
            content: [{ kind: "text", text: '{"count":1}' }],
            metadata: {},
          },
        },
      ],
      onRawAssistantText: (t) => { raw.push(t); },
    });
    expect(raw.join("")).toBe('{"count":1}');
  });
});
```

> **Note:** `runAndEmit` in the existing `run.test.ts` will need to accept and forward `onRawAssistantText` to `runHeadless`. Check the helper signature at the top of the test file and add the parameter if it is not already threaded through.

- [ ] **Step 4: Wire `onRawAssistantText` in `commands/start.ts`**

In `packages/meta/cli/src/commands/start.ts`, in the headless branch just before the `runHeadless()` call (~line 1100), insert:

```typescript
    // Raw assistant text accumulator for --result-schema validation.
    // Populated via onRawAssistantText before redactEngineBanners() is applied,
    // so schema validation sees the model's actual output, not the sanitized version.
    const rawAssistantParts: string[] = [];
```

Then pass the callback in the `runHeadless()` call:

```typescript
    const { exitCode: headlessCode, emitResult } = await runHeadless({
      sessionId: sid,
      prompt: flags.mode.text,
      maxDurationMs: flags.maxDurationMs !== undefined ? remainingForRunAndShutdown : undefined,
      writeStdout: (s) => process.stdout.write(s),
      writeStderr: (s) => process.stderr.write(s),
      runtime,
      externalSignal: controller.signal,
      onRawAssistantText: resultSchemaObj !== undefined
        ? (text) => { rawAssistantParts.push(text); }
        : undefined,
    });
```

In the post-run validation block (Task 4 Step 2), use `rawAssistantParts` instead of `assistantTextParts`:

```typescript
        const schemaResult = validateResultSchema(rawAssistantParts.join(""), resultSchemaObj);
```

- [ ] **Step 5: Typecheck**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun run typecheck --filter=@koi/cli 2>&1 | tail -5
```

Expected: `Tasks: 1 successful`

- [ ] **Step 6: Commit**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
git add packages/meta/cli/src/commands/start.ts
git commit -m "feat(headless): boot-time schema load + assistant text accumulation (#1648)"
```

---

## Task 4: Post-Run Schema Validation

**Files:**
- Modify: `packages/meta/cli/src/commands/start.ts`
- Modify: `packages/meta/cli/src/commands/start.test.ts`

- [ ] **Step 1: Write the failing tests**

Two test layers are needed:

**Layer A — Unit tests for the validation helper** (colocated in `headless/validate-schema.test.ts`): verify `validateResultSchema` error strings for all input shapes.

**Layer B — `commands/start.ts` integration tests** (appended to `packages/meta/cli/src/commands/start.test.ts`): verify exit-code precedence, raw-text wiring, and `result` event emission using mocks. The existing test file already mocks `runHeadless` and `Bun.file` — follow the same pattern.

**Layer B tests** (append to `packages/meta/cli/src/commands/start.test.ts`):

```typescript
import { mock, spyOn } from "bun:test";
import { HEADLESS_EXIT } from "../headless/exit-codes.js";
import * as runModule from "../headless/run.js";
import * as validateModule from "../headless/validate-schema.js";

describe("commands/start — --result-schema wiring (#1648)", () => {
  const VALID_SCHEMA = '{"type":"object","required":["count"]}';

  beforeEach(() => {
    // Reset mocks between tests
    mock.restore();
  });

  test("exit 5 when schema file cannot be read", async () => {
    const bunFileMock = spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.reject(new Error("ENOENT: no such file or directory")),
    } as ReturnType<typeof Bun.file>);

    const exitCodes: number[] = [];
    const stdoutLines: string[] = [];
    await runStartHeadless({
      args: ["--headless", "--prompt", "hello", "--result-schema", "./missing.json"],
      onStdout: (line) => stdoutLines.push(line),
      onExit: (code) => exitCodes.push(code),
    });

    expect(exitCodes[0]).toBe(HEADLESS_EXIT.INTERNAL);
    expect(stdoutLines.some((l) => l.includes("result-schema rejected"))).toBe(true);
    bunFileMock.mockRestore();
  });

  test("exit 5 when schema file contains invalid JSON", async () => {
    spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve("not json {{{"),
    } as ReturnType<typeof Bun.file>);

    const exitCodes: number[] = [];
    await runStartHeadless({
      args: ["--headless", "--prompt", "hello", "--result-schema", "./bad.json"],
      onExit: (code) => exitCodes.push(code),
    });

    expect(exitCodes[0]).toBe(HEADLESS_EXIT.INTERNAL);
  });

  test("exit 1 when agent succeeds but output fails schema", async () => {
    spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    // Simulate agent: exit 0, emits raw text that fails schema
    spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.onRawAssistantText?.("not json");
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: { exitCode?: number; error?: string }) => {
          opts.writeStdout(JSON.stringify({ kind: "result", exitCode: args?.exitCode ?? 0, error: args?.error }) + "\n");
        },
      };
    });

    const stdoutLines: string[] = [];
    const exitCodes: number[] = [];
    await runStartHeadless({
      args: ["--headless", "--prompt", "hello", "--result-schema", "./schema.json"],
      onStdout: (line) => stdoutLines.push(line),
      onExit: (code) => exitCodes.push(code),
    });

    const resultLine = stdoutLines.find((l) => l.includes('"kind":"result"'));
    expect(resultLine).toBeDefined();
    const result = JSON.parse(resultLine!);
    expect(result.exitCode).toBe(HEADLESS_EXIT.AGENT_FAILURE);
    expect(result.error).toContain("not valid JSON");
  });

  test("exit 0 when agent succeeds and output matches schema", async () => {
    spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.onRawAssistantText?.('{"count":5}');
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: { exitCode?: number; error?: string }) => {
          opts.writeStdout(JSON.stringify({ kind: "result", exitCode: args?.exitCode ?? 0 }) + "\n");
        },
      };
    });

    const stdoutLines: string[] = [];
    await runStartHeadless({
      args: ["--headless", "--prompt", "hello", "--result-schema", "./schema.json"],
      onStdout: (line) => stdoutLines.push(line),
      onExit: () => {},
    });

    const resultLine = stdoutLines.find((l) => l.includes('"kind":"result"'));
    const result = JSON.parse(resultLine!);
    expect(result.exitCode).toBe(HEADLESS_EXIT.SUCCESS);
  });

  test("shutdown failure takes precedence: exit 5 even when schema would pass", async () => {
    spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.onRawAssistantText?.('{"count":5}');
      return {
        exitCode: HEADLESS_EXIT.SUCCESS,
        emitResult: (args?: { exitCode?: number; error?: string }) => {
          opts.writeStdout(JSON.stringify({ kind: "result", exitCode: args?.exitCode ?? 0, error: args?.error }) + "\n");
        },
      };
    });

    // Simulate shutdownFailed=true by making shutdownRuntime throw
    spyOn(await import("../runtime/lifecycle.js"), "shutdownRuntime").mockImplementation(async () => {
      throw new Error("disposer blew up");
    });

    const stdoutLines: string[] = [];
    await runStartHeadless({
      args: ["--headless", "--prompt", "hello", "--result-schema", "./schema.json"],
      onStdout: (line) => stdoutLines.push(line),
      onExit: () => {},
    });

    const resultLine = stdoutLines.find((l) => l.includes('"kind":"result"'));
    const result = JSON.parse(resultLine!);
    expect(result.exitCode).toBe(HEADLESS_EXIT.INTERNAL);
  });

  test("schema validation skipped when agent exits non-zero", async () => {
    spyOn(Bun, "file").mockReturnValue({
      text: () => Promise.resolve(VALID_SCHEMA),
    } as ReturnType<typeof Bun.file>);

    const validateSpy = spyOn(validateModule, "validateResultSchema");

    spyOn(runModule, "runHeadless").mockImplementation(async (opts) => {
      opts.onRawAssistantText?.('{"count":5}');
      return {
        exitCode: HEADLESS_EXIT.TIMEOUT,
        emitResult: (args?: { exitCode?: number }) => {
          opts.writeStdout(JSON.stringify({ kind: "result", exitCode: args?.exitCode ?? HEADLESS_EXIT.TIMEOUT }) + "\n");
        },
      };
    });

    await runStartHeadless({
      args: ["--headless", "--prompt", "hello", "--result-schema", "./schema.json"],
      onStdout: () => {},
      onExit: () => {},
    });

    // validateResultSchema must NOT be called when agent already failed
    expect(validateSpy).not.toHaveBeenCalled();
  });
});
```

> **Note on `runStartHeadless` helper:** This is the test helper already present in `commands/start.test.ts` for headless runs. Check the existing helper signature at the top of the file and thread the new `onStdout` and `onExit` callbacks if they are not already there. The helper should capture stdout writes and the process exit code without actually calling `process.exit`.

Add the following `describe` block to `packages/meta/cli/src/headless/validate-schema.test.ts` (the file created in Task 1):

```typescript
describe("validateResultSchema — end-to-end schema validation path", () => {
  const schema: Record<string, unknown> = {
    type: "object",
    required: ["count", "titles"],
    properties: {
      count: { type: "number" },
      titles: { type: "array" },
    },
  };

  test("success: valid JSON matching schema → ok true", () => {
    const result = validateResultSchema('{"count":3,"titles":["a","b","c"]}', schema);
    expect(result.ok).toBe(true);
  });

  test("non-JSON output → ok false, error contains 'not valid JSON'", () => {
    const result = validateResultSchema("Here is your summary: ...", schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  test("valid JSON missing required field → ok false, error contains field name", () => {
    const result = validateResultSchema('{"count":3}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("schema validation failed");
      expect(result.error).toContain("titles");
    }
  });

  test("valid JSON wrong field type → ok false, error contains field path", () => {
    const result = validateResultSchema('{"count":"three","titles":[]}', schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("count");
  });

  test("empty assembled text → ok false (empty string is not valid JSON)", () => {
    const result = validateResultSchema("", schema);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("not valid JSON");
  });

  test("multi-chunk assembly: concatenated deltas validate as one JSON blob", () => {
    // Simulate three assistant_text deltas joining into one JSON object.
    const chunk1 = '{"count":2,"tit';
    const chunk2 = 'les":["foo",';
    const chunk3 = '"bar"]}';
    const assembled = chunk1 + chunk2 + chunk3;
    const result = validateResultSchema(assembled, schema);
    expect(result.ok).toBe(true);
  });
});
```

- [ ] **Step 2: Add post-run schema validation to commands/start.ts**

In `packages/meta/cli/src/commands/start.ts`, find the block starting at ~line 1139:

```typescript
      if (shutdownFailed) {
        finalCode = HEADLESS_EXIT.INTERNAL;
        emitResult({
          exitCode: HEADLESS_EXIT.INTERNAL,
          error: `teardown failure (run exited ${headlessCode}); see stderr for disposer / transcript errors`,
        });
      } else {
        emitResult();
      }
```

Replace the `else { emitResult(); }` branch with:

```typescript
      } else if (resultSchemaObj !== undefined && headlessCode === HEADLESS_EXIT.SUCCESS) {
        // --result-schema: validate the assembled assistant text against the schema.
        // Only runs when the agent succeeded (exit 0) and teardown was clean.
        // shutdownFailed=true takes precedence and is handled by the branch above.
        const schemaResult = validateResultSchema(rawAssistantParts.join(""), resultSchemaObj);
        if (!schemaResult.ok) {
          finalCode = HEADLESS_EXIT.AGENT_FAILURE;
          emitResult({ exitCode: HEADLESS_EXIT.AGENT_FAILURE, error: schemaResult.error });
        } else {
          emitResult();
        }
      } else {
        emitResult();
      }
```

Also update the import at the top of the file (in the `../headless/validate-schema.js` import added in Task 3 Step 1) to include `validateResultSchema`:

```typescript
import { validateLoadedSchema, validateResultSchema } from "../headless/validate-schema.js";
```

- [ ] **Step 3: Run the CLI package tests**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun run test --filter=@koi/cli 2>&1 | tail -15
```

Expected: all tests pass including the new `--result-schema` flag test.

- [ ] **Step 4: Typecheck**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun run typecheck --filter=@koi/cli 2>&1 | tail -5
```

Expected: `Tasks: 1 successful`

- [ ] **Step 5: Lint**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun run lint --filter=@koi/cli 2>&1 | tail -10
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
git add packages/meta/cli/src/commands/start.ts packages/meta/cli/src/commands/start.test.ts
git commit -m "feat(headless): post-run JSON Schema validation via --result-schema (#1648)"
```

---

## Task 5: Documentation — `docs/guides/headless-mode.md`

**Files:**
- Create: `docs/guides/headless-mode.md`

- [ ] **Step 1: Write the guide**

Create `docs/guides/headless-mode.md`:

````markdown
# Headless Mode

Headless mode (`koi start --headless`) runs an agent as a non-interactive one-shot process. It is designed for CI/CD pipelines, GitHub Actions, cron jobs, and any automation where a human is not watching the terminal.

All agent output is emitted as newline-delimited JSON (NDJSON) on **stdout**. Diagnostics go to **stderr**. The process exits with a structured exit code in the range 0–5.

## Quick Start

```bash
koi start --headless \
  --prompt "List the 3 most recent open GitHub issues as JSON" \
  --allow-tool web_fetch \
  --max-turns 10 \
  --max-duration-ms 60000
```

## Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--headless` | boolean | false | Enable headless mode. Requires `--prompt`. |
| `--prompt` / `-p` | string | — | The prompt to send to the agent. Required in headless mode. |
| `--allow-tool` | string (repeatable) | [] | Exact tool ID to auto-allow. All other tool requests are denied. |
| `--max-duration-ms` | integer | none | Hard wall-clock timeout in milliseconds. Covers bootstrap + run + teardown. |
| `--max-turns` | integer | 25 | Maximum number of agent turns before stopping with exit 3. |
| `--max-spend` | number | none | Maximum spend in USD before stopping with exit 3. |
| `--result-schema` | string | none | Path to a JSON Schema file. Validates the agent's text output. Exit 1 on failure. |
| `--manifest` | string | none | Path to an agent manifest YAML file. |
| `--verbose` / `-v` | boolean | false | Emit additional diagnostic lines to stderr. |

### `--allow-tool` whitelist

In headless mode, **all tool requests are denied by default**. Pass `--allow-tool <toolId>` (repeatable) to selectively allow tools. Tool IDs are exact names: `fs_read`, `web_fetch`, `Bash`, `Glob`, `Grep`, etc.

```bash
# Allow filesystem reads and web fetches, deny everything else
koi start --headless --prompt "..." \
  --allow-tool fs_read \
  --allow-tool web_fetch
```

Wildcards are not supported — each `--allow-tool` value must be an exact tool ID.

### Security defaults

The following are **off by default** in headless mode and require environment variable opt-in:

| Feature | Env var to enable |
|---------|------------------|
| MCP server connections | `KOI_HEADLESS_ALLOW_MCP=1` |
| Manifest-declared plugins (user-installed plugin autoload remains disabled) | `KOI_HEADLESS_ALLOW_PLUGINS=1` |
| Manifest-declared middleware | `KOI_HEADLESS_ALLOW_MIDDLEWARE=1` |
| User hook scripts | `KOI_HEADLESS_ALLOW_HOOKS=1` |
| Session transcript persistence | `KOI_HEADLESS_PERSIST_TRANSCRIPT=1` |

These are fail-closed by default because they represent bootstrap-time execution surfaces that run before `--allow-tool` can mediate anything.

## Exit Codes

| Code | Name | Meaning | Retry? |
|------|------|---------|--------|
| 0 | SUCCESS | Agent completed the task | — |
| 1 | AGENT_FAILURE | Agent could not complete the task, or output failed schema validation | Yes, if idempotent |
| 2 | PERMISSION_DENIED | A required tool was denied by the permission policy | No — add `--allow-tool` |
| 3 | BUDGET_EXCEEDED | `--max-turns` or `--max-spend` was hit | Maybe — raise limits |
| 4 | TIMEOUT | `--max-duration-ms` was exceeded | Only when MCP is disabled (`KOI_HEADLESS_ALLOW_MCP` unset). With MCP enabled, tool calls may have committed non-idempotent side effects before the timeout — retrying can cause duplicate actions. |
| 5 | INTERNAL | Runtime assembly failed, schema file was invalid, or teardown failed | Check stderr |

## NDJSON Event Reference

Each line on stdout is a JSON object with a `sessionId` field and a `kind` field.

### `session_start`

Emitted once at the start of the run.

```json
{"kind":"session_start","sessionId":"ses_abc123","startedAt":"2026-04-21T10:00:00.000Z"}
```

### `assistant_text`

Emitted for each chunk of text the agent produces.

```json
{"kind":"assistant_text","sessionId":"ses_abc123","text":"Here is the summary: ..."}
```

### `tool_call`

Emitted when the agent calls a tool. Args are summarized (type + size) — raw values are not logged to protect CI secrets.

```json
{"kind":"tool_call","sessionId":"ses_abc123","toolName":"web_fetch","args":{"type":"object","size":1}}
```

### `tool_result`

Emitted when a tool returns. Results are summarized for the same reason.

```json
{"kind":"tool_result","sessionId":"ses_abc123","toolName":"web_fetch","ok":true,"result":{"type":"string","size":4200}}
```

### `result`

The terminal event. Always the last line. Contains the final exit code.

```json
{"kind":"result","sessionId":"ses_abc123","ok":true,"exitCode":0}
```

On failure:

```json
{"kind":"result","sessionId":"ses_abc123","ok":false,"exitCode":1,"error":"schema validation failed: .titles is required"}
```

## Result Schema Validation

Use `--result-schema` to enforce that the agent's text output is valid JSON matching a JSON Schema.

**Example schema** (`.koi/pr-summary-schema.json`):

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

**Supported keywords:** `type`, `required`, `properties`, `enum`.

**Unsupported keywords** (e.g. `$ref`, `anyOf`, `pattern`) cause the schema to be rejected at boot with exit 5.

If the agent's output is not valid JSON, or does not match the schema, the run exits with code 1 and an error message like:

```
{"kind":"result","ok":false,"exitCode":1,"error":"schema validation failed: .titles is required"}
```

## CI Recipe — GitHub Actions

```yaml
name: Koi Agent Run

on:
  workflow_dispatch:
    inputs:
      prompt:
        description: "Prompt for the agent"
        required: true

jobs:
  run-agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install Koi
        run: npm install -g @koi/cli

      - name: Run agent
        id: koi
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          # Pass prompt via env var — never interpolate untrusted input
          # directly into shell source (${{ inputs.prompt }} could contain
          # quotes or shell metacharacters that execute on the runner).
          KOI_PROMPT: ${{ inputs.prompt }}
        run: |
          koi start --headless \
            --prompt "$KOI_PROMPT" \
            --allow-tool fs_read \
            --allow-tool web_fetch \
            --max-turns 20 \
            --max-duration-ms 120000 \
            --result-schema .koi/output-schema.json \
            > koi-output.ndjson
        continue-on-error: true

      - name: Check result
        run: |
          # Use jq structural selection — grep for '"kind":"result"' is
          # unsafe because assistant output is model-controlled and could
          # contain that substring, producing false positives.
          RESULT=$(jq -rc 'select(.kind=="result")' < koi-output.ndjson | tail -n1)
          EXIT=$(echo "$RESULT" | jq -r '.exitCode')
          echo "koi exit code: $EXIT"
          if [ "$EXIT" != "0" ]; then
            echo "Agent failed: $(echo "$RESULT" | jq -r '.error // "no error message"')"
            exit 1
          fi

      # OPTIONAL DEBUG ONLY: Do not enable this in production workflows.
      # koi-output.ndjson contains assistant_text events which may include
      # sensitive data from tool outputs. Treat the file as sensitive and
      # never upload it by default. Only enable this step when debugging,
      # and ensure artifact access is restricted to trusted collaborators.
      #
      # - name: Upload NDJSON log (DEBUG ONLY)
      #   if: always()
      #   uses: actions/upload-artifact@v4
      #   with:
      #     name: koi-output
      #     path: koi-output.ndjson
```

The `continue-on-error: true` on the agent step ensures the "Check result" step always runs, giving you control over how exit codes map to workflow failures.
````

- [ ] **Step 2: Verify the file exists and is well-formed**

```bash
wc -l /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode/docs/guides/headless-mode.md
head -5 /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode/docs/guides/headless-mode.md
```

Expected: file exists, starts with `# Headless Mode`.

- [ ] **Step 3: Run full CI gate**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun run test --filter=@koi/cli 2>&1 | tail -10
bun run typecheck --filter=@koi/cli 2>&1 | tail -5
bun run lint --filter=@koi/cli 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
git add docs/guides/headless-mode.md
git commit -m "docs: headless mode guide + GitHub Actions recipe (#1648)"
```

---

## Final Verification

- [ ] **Run the full monorepo CI gate**

```bash
cd /Users/sophiawj/private/koi/.worktrees/feat/headless-ci-mode
bun run test 2>&1 | tail -10
bun run typecheck 2>&1 | tail -5
bun run lint 2>&1 | tail -5
bun run check:layers 2>&1 | tail -5
```

Expected: all pass.

- [ ] **Verify acceptance criteria**

Check each item from issue #1648 is met:
- [x] `--headless` flag disables TUI (pre-existing)
- [x] JSON structured output on stdout/stderr (pre-existing)
- [x] Ask permissions handled without blocking (pre-existing)
- [x] All 6 exit codes documented and tested (pre-existing + Task 5 docs)
- [x] Hard budget flags enforced (pre-existing)
- [x] Result schema validation — Task 1–4
- [x] Sample GitHub Actions workflow in docs — Task 5
- [x] Tests cover all exit paths (pre-existing + Task 1–4)
- [x] Documented in `docs/guides/headless-mode.md` — Task 5
