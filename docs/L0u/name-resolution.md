# @koi/name-resolution — Pure ANS Algorithms (L0u)

Shared utility functions for the Agent Name Service (ANS): composite key construction, name validation, scoped resolution, and fuzzy "did you mean?" matching. Used by both `@koi/name-service` (in-memory) and `@koi/name-service-nexus` (Nexus-backed) backends.

---

## Why It Exists

Both the in-memory and Nexus-backed name service backends need the same core algorithms: building `scope:name` composite keys, validating name format, resolving names through scope priority (agent → zone → global), and computing Levenshtein-based suggestions for typos.

Before this package, these algorithms lived inside `@koi/name-service`. When `@koi/name-service-nexus` was added as a second backend, duplicating them would violate DRY and create drift risk. Extracting them to a shared L0u package lets both L2 backends depend on the same tested implementations.

---

## API

### `compositeKey(scope, name): string`

Builds a `"${scope}:${name}"` key used for Map-based record and alias lookups.

### `parseCompositeKey(key): { scope: ForgeScope, name: string } | undefined`

Inverse of `compositeKey`. Returns `undefined` if the key has no colon separator.

### `validateName(name): Result<string, KoiError>`

Validates a name against `/^[a-z][a-z0-9-]*$/` with a 128-character max. Returns `Result<string, KoiError>` — error code is `VALIDATION`.

### `resolveByScope(name, scope, records, aliases): Result<NameResolution, KoiError>`

Resolves a name through scope priority order (agent → zone → global). If an explicit scope is provided, only that scope is checked. Checks aliases as a fallback for each scope.

### `computeSuggestions(name, scope, records, config): readonly NameSuggestion[]`

Fuzzy matching using Levenshtein distance. Returns up to `config.maxSuggestions` names within `config.maxSuggestionDistance` edit distance, sorted by distance then alphabetically.

---

## Layer Compliance

```
L0  @koi/core ──────────────────────────────────────────┐
    ForgeScope, NameRecord, NameResolution, NameBinding,  │
    NameSuggestion, AnsConfig, KoiError, Result           │
                                                          │
L0u @koi/validation ─────────────────────────────────────┤
    levenshteinDistance() — reused for fuzzy matching      │
                                                          │
L0u @koi/name-resolution ◄──────────────────────────────┘
    imports from L0 + peer L0u only
```

---

## File Structure

```
packages/lib/name-resolution/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    ├── index.ts                  # Public exports
    ├── composite-key.ts          # compositeKey() + parseCompositeKey()
    ├── composite-key.test.ts
    ├── name-validation.ts        # validateName()
    ├── name-validation.test.ts
    ├── scope-resolver.ts         # resolveByScope()
    ├── scope-resolver.test.ts
    ├── fuzzy-matcher.ts          # computeSuggestions()
    ├── fuzzy-matcher.test.ts
    └── __tests__/
        └── api-surface.test.ts   # DTS snapshot test
```
