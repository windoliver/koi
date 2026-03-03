# Descriptor Validation Helpers

Shared validation utilities for `BrickDescriptor.optionsValidator` functions. Eliminates the typeof-object boilerplate duplicated across 47+ descriptor files.

---

## Why It Exists

Every L2 package that registers a `BrickDescriptor` needs an `optionsValidator` function. Before these helpers, each package copy-pasted the same 10-15 lines:

```typescript
// This exact block was duplicated 47 times:
function validateFooOptions(input: unknown): Result<unknown, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Foo options must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }
  const opts = input as Record<string, unknown>; // banned cast
  // ...field-specific checks...
}
```

Problems with copy-paste:
- **28 banned `as` casts** — each file cast `input as Record<string, unknown>` after the type guard
- **3 inconsistent `retryable` values** — some files used `false` instead of `RETRYABLE_DEFAULTS.VALIDATION`
- **Maintenance burden** — changing the error format required editing 47 files

---

## What It Provides

Two helpers in `@koi/resolve`, exported for use by all descriptor files:

### `validateOptionalDescriptorOptions(input, label)`

Lenient — accepts `null`/`undefined` as empty `{}`. Use for engines, channels, and other descriptors where options are truly optional.

```typescript
import { validateOptionalDescriptorOptions } from "@koi/resolve";

// Simple descriptor (no field validation needed):
export const descriptor: BrickDescriptor<EngineAdapter> = {
  optionsValidator: (input) => validateOptionalDescriptorOptions(input, "Loop engine"),
  // ...
};
```

### `validateRequiredDescriptorOptions(input, label)`

Strict — rejects `null`/`undefined`. Use for middleware and services where an options object is expected.

```typescript
import { validateRequiredDescriptorOptions } from "@koi/resolve";

// Simple descriptor:
export const descriptor: BrickDescriptor<KoiMiddleware> = {
  optionsValidator: (input) => validateRequiredDescriptorOptions(input, "Sandbox"),
  // ...
};
```

### Complex descriptors (with field-level validation)

For descriptors that validate specific fields after the object check, use the helper to replace only the boilerplate:

```typescript
import { validateRequiredDescriptorOptions } from "@koi/resolve";

function validateAuditDescriptorOptions(
  input: unknown,
): Result<Record<string, unknown>, KoiError> {
  const base = validateRequiredDescriptorOptions(input, "Audit");
  if (!base.ok) return base;
  const opts = base.value; // narrowed to Record<string, unknown> — no cast needed

  if (opts.maxEntrySize !== undefined && typeof opts.maxEntrySize !== "number") {
    return { ok: false, error: { code: "VALIDATION", message: "...", retryable: RETRYABLE_DEFAULTS.VALIDATION } };
  }

  return { ok: true, value: opts };
}
```

---

## `findClosestMatch` — "Did you mean?" suggestions

Also extracted as part of this work: `findClosestMatch` in `@koi/validation` provides Levenshtein-based typo suggestions. Previously duplicated between `@koi/manifest` and `@koi/resolve`.

```typescript
import { findClosestMatch } from "@koi/validation";

const suggestion = findClosestMatch("audti", ["audit", "sandbox", "pay"]);
// → "audit"
```

Used by the resolver to produce helpful error messages:

```
middleware "audti" not found in registry. Available: [audit, sandbox, pay]. Did you mean "audit"?
```

---

## Architecture

Both helpers live in **L0u** packages — the same layer as the descriptors that consume them:

```
L0   @koi/core          Types only (KoiError, Result, RETRYABLE_DEFAULTS)
L0u  @koi/validation    findClosestMatch (+ levenshteinDistance)
L0u  @koi/resolve       validateOptionalDescriptorOptions, validateRequiredDescriptorOptions
L2   @koi/middleware-*   Import from @koi/resolve — no layer violation
L2   @koi/engine-*       Import from @koi/resolve — no layer violation
L2   @koi/channel-*      Import from @koi/resolve — no layer violation
```

No new packages were created. No new dependencies were added to any `package.json`.

---

## How Resolution Works (end-to-end)

```
koi.yaml (manifest)
    │
    ▼
Resolver reads manifest sections (engine, middleware, channel, model)
    │
    │  For each entry:
    │  1. Look up BrickDescriptor in registry by name
    │     └─ Not found? → findClosestMatch → "Did you mean ...?"
    │  2. Call descriptor.optionsValidator(options)
    │     └─ Uses validateOptional/RequiredDescriptorOptions
    │  3. Call descriptor.factory(validatedOptions, context)
    │     └─ Returns live EngineAdapter / KoiMiddleware / ChannelAdapter
    │
    ▼
Running agent with resolved components
```
