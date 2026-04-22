# `@koi/bash-ast` Per-Command Semantic Specs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-command semantic specs (`specRm`, `specCp`, …, `specSsh`) to `@koi/bash-ast` that map a resolved `argv: readonly string[]` to a `SpecResult` discriminated union (`complete` / `partial` / `refused`) describing reads, writes, network access, and env mutations. No consumer wiring in this PR.

**Architecture:** Pure-function specs co-located in `packages/lib/bash-ast/src/specs/`. Shared `parse-flags.ts` + `posix-basename.ts` helpers; each spec file < 80 lines. Discriminated `SpecResult` lets specs preserve argv-derivable facts (`partial`) while machine-signaling under-modeling, with `refused` reserved for parse failure or deliberately-unsupported forms. `BUILTIN_SPECS` is an exported `ReadonlyMap`; `createSpecRegistry()` returns a fresh mutable `Map` seeded with builtins; `registerSpec(reg, name, fn)` is a thin one-line helper. Specs are exported but unconsumed in this PR — security value is gated on the follow-up consumer PR.

**Tech Stack:** Bun 1.3.x runtime + `bun:test`; TypeScript 6 strict (`isolatedDeclarations`, `verbatimModuleSyntax`, `erasableSyntaxOnly`, `exactOptionalPropertyTypes`); ESM with `.js` import paths; tsup build; Biome lint.

**Spec doc:** `docs/superpowers/specs/2026-04-18-bash-ast-command-specs-design.md` — single source of truth. Re-read whenever a step refers to a `kind`/`reason`/`detail` string.

**Branch:** `feat/issue-1662-bash-specs` (already created in worktree).

---

## File map

All paths relative to repo root.

**Create (new):**
- `packages/lib/bash-ast/src/specs/types.ts` — `CommandSemantics`, `NetworkAccess`, `SpecResult`, `CommandSpec`
- `packages/lib/bash-ast/src/specs/parse-flags.ts` — shared bundled-flag splitter, value-flag handling, `--` cutoff, allowlist enforcement
- `packages/lib/bash-ast/src/specs/parse-flags.test.ts`
- `packages/lib/bash-ast/src/specs/posix-basename.ts` — pure POSIX basename (trailing-slash strip; refuses `/` and empty)
- `packages/lib/bash-ast/src/specs/posix-basename.test.ts`
- `packages/lib/bash-ast/src/specs/rm.ts` + `rm.test.ts`
- `packages/lib/bash-ast/src/specs/chmod.ts` + `chmod.test.ts`
- `packages/lib/bash-ast/src/specs/chown.ts` + `chown.test.ts`
- `packages/lib/bash-ast/src/specs/mv.ts` + `mv.test.ts`
- `packages/lib/bash-ast/src/specs/cp.ts` + `cp.test.ts`
- `packages/lib/bash-ast/src/specs/tar.ts` + `tar.test.ts`
- `packages/lib/bash-ast/src/specs/curl.ts` + `curl.test.ts`
- `packages/lib/bash-ast/src/specs/wget.ts` + `wget.test.ts`
- `packages/lib/bash-ast/src/specs/scp.ts` + `scp.test.ts`
- `packages/lib/bash-ast/src/specs/ssh.ts` + `ssh.test.ts`
- `packages/lib/bash-ast/src/specs/registry.ts` + `registry.test.ts`
- `packages/lib/bash-ast/src/specs/index.ts` — re-exports types, registry, ten spec functions

**Modify:**
- `packages/lib/bash-ast/src/index.ts` — add one re-export line for the specs barrel
- `docs/L2/bash-ast.md` — append "Per-command semantics" section (public API, allowlists, `SpecResult` contract, exact-argv `Run(...)` guard, link to follow-up issue)

**External:**
- Open follow-up tracking issue via `gh issue create`

---

## Common patterns (read once before any task)

**Test file boilerplate:**
```typescript
import { describe, expect, test } from "bun:test";
import { specXxx } from "../xxx.js"; // adjust per file
```

**Run a single test file:**
```bash
bun test packages/lib/bash-ast/src/specs/<file>.test.ts
```

**Run the whole package's tests:**
```bash
bun run test --filter=@koi/bash-ast
```

**Commit format:** `feat(bash-ast): <one-line description> (#1662)`. Pre-commit hook runs lint + filter-tests automatically.

**TS 6 reminders for every new file:**
- Always `import type { … } from "./foo.js"` for types-only imports.
- Explicit return type on every exported function (`isolatedDeclarations`).
- Use `as const` only for genuine literal narrowing; never `as Type`.
- All interface properties `readonly`.
- All array params `readonly T[]`.
- No `class` (Map is the registry).

---

### Task 1: Define public types

**Files:**
- Create: `packages/lib/bash-ast/src/specs/types.ts`

- [ ] **Step 1: Write the file**

```typescript
/**
 * @koi/bash-ast/specs — public types for per-command semantic specs.
 *
 * See `docs/superpowers/specs/2026-04-18-bash-ast-command-specs-design.md`
 * for the full soundness contract. Summary:
 *   - `complete`  — argv-derived I/O accounting is complete; consumer
 *                   may use `semantics` as the sole input to argv-aware
 *                   `Read`/`Write`/`Network` rules.
 *   - `partial`   — populated fields are an under-approximation;
 *                   consumer MUST require an exact-argv `Run(...)`
 *                   co-rule for this argv. `reason` names the gap.
 *   - `refused`   — no semantics; consumer MUST use exact-argv
 *                   `Run(...)` rules and MUST NOT feed this argv into
 *                   any argv-aware rule. `cause` discriminates parse
 *                   failure from deliberate refusal; `detail` is for
 *                   audit logs.
 */

export interface CommandSemantics {
  readonly reads: readonly string[];
  readonly writes: readonly string[];
  readonly network: readonly NetworkAccess[];
  readonly envMutations: readonly string[];
}

export interface NetworkAccess {
  readonly kind: "http" | "ssh" | "ftp";
  /** Raw argv string — full URL for curl/wget, hostname for ssh/scp. */
  readonly target: string;
  /**
   * Extracted host for `Network(host)` rule matching. For URL-bearing
   * commands the spec parses the URL and stores `URL.host`. For ssh/scp
   * this would equal `target`, but ssh/scp always return `refused` in
   * this PR so no NetworkAccess is emitted from them.
   */
  readonly host: string;
}

export type SpecResult =
  | { readonly kind: "complete"; readonly semantics: CommandSemantics }
  | {
      readonly kind: "partial";
      readonly semantics: CommandSemantics;
      readonly reason: string;
    }
  | {
      readonly kind: "refused";
      readonly cause: "parse-error" | "unsupported-form";
      readonly detail: string;
    };

export type CommandSpec = (argv: readonly string[]) => SpecResult;
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run --cwd packages/lib/bash-ast typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/types.ts
git commit -m "feat(bash-ast): add SpecResult/CommandSemantics types for per-command specs (#1662)"
```

---

### Task 2: POSIX basename helper — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/posix-basename.test.ts`

`posixBasename(src)` returns `{ ok: true; value: string } | { ok: false }`. POSIX semantics: strip trailing `/`, then take the last segment. Refuses `/`, empty string, and any input that normalizes to empty.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { posixBasename } from "../posix-basename.js";

describe("posixBasename — POSIX-style basename", () => {
  test("returns last segment for plain path", () => {
    expect(posixBasename("foo")).toEqual({ ok: true, value: "foo" });
    expect(posixBasename("a/b/foo.txt")).toEqual({ ok: true, value: "foo.txt" });
  });

  test("strips trailing slash before extracting", () => {
    expect(posixBasename("foo/")).toEqual({ ok: true, value: "foo" });
    expect(posixBasename("a/b/foo/")).toEqual({ ok: true, value: "foo" });
  });

  test("strips multiple trailing slashes", () => {
    expect(posixBasename("foo///")).toEqual({ ok: true, value: "foo" });
  });

  test("refuses root", () => {
    expect(posixBasename("/")).toEqual({ ok: false });
    expect(posixBasename("////")).toEqual({ ok: false });
  });

  test("refuses empty string", () => {
    expect(posixBasename("")).toEqual({ ok: false });
  });

  test("preserves absolute paths' basename", () => {
    expect(posixBasename("/etc/passwd")).toEqual({ ok: true, value: "passwd" });
    expect(posixBasename("/usr/local/")).toEqual({ ok: true, value: "local" });
  });

  test("handles single-segment relative paths with leading dot", () => {
    expect(posixBasename("./foo")).toEqual({ ok: true, value: "foo" });
    expect(posixBasename(".")).toEqual({ ok: true, value: "." });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/posix-basename.test.ts`
Expected: error "Cannot find module './posix-basename.js'".

---

### Task 3: POSIX basename helper — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/posix-basename.ts`

- [ ] **Step 1: Write the implementation**

```typescript
/**
 * Pure POSIX-style basename. Strips trailing `/` from the input, then
 * returns the segment after the last `/`. Refuses `/`, empty input,
 * and any input whose stripped form is empty.
 *
 * Returns a Result so callers can fold into `kind: "refused"` without
 * exception handling.
 */

export type BasenameResult =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false };

export function posixBasename(src: string): BasenameResult {
  if (src === "") return { ok: false };

  let end = src.length;
  while (end > 0 && src[end - 1] === "/") end -= 1;
  if (end === 0) return { ok: false };

  const stripped = src.slice(0, end);
  const lastSlash = stripped.lastIndexOf("/");
  const value = lastSlash === -1 ? stripped : stripped.slice(lastSlash + 1);
  if (value === "") return { ok: false };
  return { ok: true, value };
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/posix-basename.test.ts`
Expected: 7 tests pass, 0 fail.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/posix-basename.ts \
        packages/lib/bash-ast/src/specs/posix-basename.test.ts
git commit -m "feat(bash-ast): add POSIX basename helper for cp/mv -t derivation (#1662)"
```

---

### Task 4: parse-flags helper — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/parse-flags.test.ts`

`parseFlags(argv, allow)` parses `argv[1..]` (argv[0] is the command name) against a per-command allowlist describing which short/long flags exist and which take a value. Returns either a parsed structure or a refusal.

The shape:
```typescript
type FlagAllowlist = {
  readonly bool: ReadonlySet<string>;   // e.g. "r", "R", "f", "verbose"
  readonly value: ReadonlySet<string>;  // e.g. "t", "output"
};
type ParsedFlags =
  | { readonly ok: true; readonly flags: ReadonlyMap<string, string | true>; readonly positionals: readonly string[] }
  | { readonly ok: false; readonly detail: string };
```

Key behaviours to test:
- Bundled short flags (`-rf` → `-r -f`) when both are bool.
- Long-flag value form: `--output FILE` and `--output=FILE`.
- Short-flag value form: `-o FILE` and `-oFILE`.
- `--` cutoff: everything after is positional, even if it starts with `-`.
- Unknown flag → ok:false.
- Missing required value (`-o` with no following argv) → ok:false.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { parseFlags } from "../parse-flags.js";

const allow = {
  bool: new Set(["r", "R", "f", "i", "v"]),
  value: new Set(["t", "output"]),
};

describe("parseFlags — short-flag handling", () => {
  test("recognised single short bool flag", () => {
    const result = parseFlags(["rm", "-r", "foo"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("r")).toBe(true);
    expect(result.positionals).toEqual(["foo"]);
  });

  test("bundled short bool flags split correctly", () => {
    const result = parseFlags(["rm", "-rf", "foo"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("r")).toBe(true);
    expect(result.flags.get("f")).toBe(true);
    expect(result.positionals).toEqual(["foo"]);
  });

  test("short value flag with separate arg", () => {
    const result = parseFlags(["cp", "-t", "/dest", "src"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("t")).toBe("/dest");
    expect(result.positionals).toEqual(["src"]);
  });

  test("short value flag attached form", () => {
    const result = parseFlags(["cp", "-t/dest", "src"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("t")).toBe("/dest");
    expect(result.positionals).toEqual(["src"]);
  });
});

describe("parseFlags — long-flag handling", () => {
  test("long bool flag", () => {
    const result = parseFlags(["cmd", "--verbose", "x"], {
      bool: new Set(["verbose"]),
      value: new Set(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("verbose")).toBe(true);
  });

  test("long value flag with space", () => {
    const result = parseFlags(["cmd", "--output", "out.txt", "in"], {
      bool: new Set(),
      value: new Set(["output"]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("output")).toBe("out.txt");
    expect(result.positionals).toEqual(["in"]);
  });

  test("long value flag with =", () => {
    const result = parseFlags(["cmd", "--output=out.txt", "in"], {
      bool: new Set(),
      value: new Set(["output"]),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("output")).toBe("out.txt");
  });
});

describe("parseFlags — `--` end-of-options", () => {
  test("everything after -- is positional", () => {
    const result = parseFlags(["rm", "-r", "--", "-foo", "-bar"], allow);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.flags.get("r")).toBe(true);
    expect(result.positionals).toEqual(["-foo", "-bar"]);
  });
});

describe("parseFlags — refusals", () => {
  test("unknown short flag", () => {
    const result = parseFlags(["rm", "-z", "foo"], allow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/unknown.*flag.*z/i);
  });

  test("unknown long flag", () => {
    const result = parseFlags(["cmd", "--zzz"], allow);
    expect(result.ok).toBe(false);
  });

  test("value flag missing its value", () => {
    const result = parseFlags(["cp", "-t"], allow);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.detail).toMatch(/missing value/i);
  });

  test("bundled short flag containing unknown rejects whole bundle", () => {
    // -rz: -r is known bool, -z is unknown. Refuse the whole call.
    const result = parseFlags(["rm", "-rz", "foo"], allow);
    expect(result.ok).toBe(false);
  });

  test("bundled short flag mixing bool and value-flag rejects", () => {
    // -tf: -t needs a value, -f is bool. Cannot bundle a value flag.
    const result = parseFlags(["cp", "-tf", "x"], allow);
    expect(result.ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/parse-flags.test.ts`
Expected: error "Cannot find module './parse-flags.js'".

---

### Task 5: parse-flags helper — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/parse-flags.ts`

- [ ] **Step 1: Write the implementation**

```typescript
/**
 * Shared flag parser for per-command specs. Each spec passes its own
 * allowlist of recognized boolean and value-taking flags. Unknown flags
 * cause the parse to refuse so the spec can return
 * `kind: "refused", cause: "parse-error"`.
 *
 * Supports:
 *   - Long flags:  `--name`, `--name VALUE`, `--name=VALUE`
 *   - Short flags: `-x`, `-x VALUE`, `-xVALUE`
 *   - Bundled bools: `-rf` → `-r -f` (only when every char is a known bool)
 *   - `--` end-of-options cutoff
 */

export interface FlagAllowlist {
  readonly bool: ReadonlySet<string>;
  readonly value: ReadonlySet<string>;
}

export type ParseFlagsResult =
  | {
      readonly ok: true;
      readonly flags: ReadonlyMap<string, string | true>;
      readonly positionals: readonly string[];
    }
  | { readonly ok: false; readonly detail: string };

export function parseFlags(
  argv: readonly string[],
  allow: FlagAllowlist,
): ParseFlagsResult {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let cutoff = false;

  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;

    if (cutoff) {
      positionals.push(tok);
      continue;
    }

    if (tok === "--") {
      cutoff = true;
      continue;
    }

    if (tok.startsWith("--")) {
      const longResult = consumeLong(tok, argv, i, allow);
      if (!longResult.ok) return longResult;
      flags.set(longResult.name, longResult.value);
      i = longResult.nextIndex;
      continue;
    }

    if (tok.startsWith("-") && tok.length > 1) {
      const shortResult = consumeShort(tok, argv, i, allow);
      if (!shortResult.ok) return shortResult;
      for (const [name, value] of shortResult.flags) flags.set(name, value);
      i = shortResult.nextIndex;
      continue;
    }

    positionals.push(tok);
  }

  return { ok: true, flags, positionals };
}

interface LongOk {
  readonly ok: true;
  readonly name: string;
  readonly value: string | true;
  readonly nextIndex: number;
}

function consumeLong(
  tok: string,
  argv: readonly string[],
  i: number,
  allow: FlagAllowlist,
): LongOk | { readonly ok: false; readonly detail: string } {
  const body = tok.slice(2);
  const eq = body.indexOf("=");
  const name = eq === -1 ? body : body.slice(0, eq);

  if (allow.bool.has(name)) {
    if (eq !== -1) {
      return { ok: false, detail: `boolean flag --${name} does not accept a value` };
    }
    return { ok: true, name, value: true, nextIndex: i };
  }

  if (allow.value.has(name)) {
    if (eq !== -1) {
      return { ok: true, name, value: body.slice(eq + 1), nextIndex: i };
    }
    const next = argv[i + 1];
    if (next === undefined) {
      return { ok: false, detail: `missing value for --${name}` };
    }
    return { ok: true, name, value: next, nextIndex: i + 1 };
  }

  return { ok: false, detail: `unknown long flag --${name}` };
}

interface ShortOk {
  readonly ok: true;
  readonly flags: ReadonlyArray<readonly [string, string | true]>;
  readonly nextIndex: number;
}

function consumeShort(
  tok: string,
  argv: readonly string[],
  i: number,
  allow: FlagAllowlist,
): ShortOk | { readonly ok: false; readonly detail: string } {
  // Try value-flag first: only the FIRST char is the flag name; rest is value.
  const head = tok[1];
  if (head !== undefined && allow.value.has(head)) {
    if (tok.length > 2) {
      return { ok: true, flags: [[head, tok.slice(2)]], nextIndex: i };
    }
    const next = argv[i + 1];
    if (next === undefined) {
      return { ok: false, detail: `missing value for -${head}` };
    }
    return { ok: true, flags: [[head, next]], nextIndex: i + 1 };
  }

  // Otherwise: every char must be a known bool.
  const out: Array<readonly [string, true]> = [];
  for (const ch of tok.slice(1)) {
    if (!allow.bool.has(ch)) {
      return { ok: false, detail: `unknown short flag -${ch}` };
    }
    out.push([ch, true]);
  }
  return { ok: true, flags: out, nextIndex: i };
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/parse-flags.test.ts`
Expected: 11 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/parse-flags.ts \
        packages/lib/bash-ast/src/specs/parse-flags.test.ts
git commit -m "feat(bash-ast): add shared flag-parser helper for specs (#1662)"
```

---

### Task 6: specRm — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/rm.test.ts`

Behaviour:
- Non-recursive: `complete`, all positionals → `writes`.
- With `-r`/`-R`/`-d`: `partial`, `reason: "recursive-subtree-root"`.
- Missing positional → `refused: parse-error`.
- Unknown flag → `refused: parse-error`.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { specRm } from "../rm.js";

describe("specRm — non-recursive", () => {
  test("returns complete with all positionals as writes", () => {
    const result = specRm(["rm", "a", "b", "c"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["a", "b", "c"]);
    expect(result.semantics.reads).toEqual([]);
    expect(result.semantics.network).toEqual([]);
    expect(result.semantics.envMutations).toEqual([]);
  });

  test("recognises -f and -i and -v as bool flags", () => {
    const result = specRm(["rm", "-f", "-i", "-v", "x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["x"]);
  });

  test("treats -- as end-of-options", () => {
    const result = specRm(["rm", "-f", "--", "-x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["-x"]);
  });
});

describe("specRm — recursive (partial)", () => {
  test("with -r returns partial recursive-subtree-root", () => {
    const result = specRm(["rm", "-r", "dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root");
    expect(result.semantics.writes).toEqual(["dir"]);
  });

  test("with -R returns partial recursive-subtree-root", () => {
    const result = specRm(["rm", "-R", "dir"]);
    expect(result.kind).toBe("partial");
  });

  test("with -d returns partial recursive-subtree-root", () => {
    const result = specRm(["rm", "-d", "dir"]);
    expect(result.kind).toBe("partial");
  });

  test("bundled -rf returns partial", () => {
    const result = specRm(["rm", "-rf", "dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.writes).toEqual(["dir"]);
  });
});

describe("specRm — refused", () => {
  test("missing positional returns parse-error", () => {
    const result = specRm(["rm"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("unknown flag returns parse-error", () => {
    const result = specRm(["rm", "-z", "x"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("dispatched on wrong command name returns parse-error", () => {
    const result = specRm(["ls", "x"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/rm.test.ts`
Expected: error "Cannot find module './rm.js'".

---

### Task 7: specRm — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/rm.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import { parseFlags } from "./parse-flags.js";
import type { SpecResult } from "./types.js";

const RM_ALLOW = {
  bool: new Set(["r", "R", "f", "i", "d", "v"]),
  value: new Set<string>(),
};

const RECURSIVE_FLAGS = ["r", "R", "d"] as const;

export function specRm(argv: readonly string[]): SpecResult {
  if (argv[0] !== "rm") {
    return { kind: "refused", cause: "parse-error", detail: "spec dispatched on non-rm argv" };
  }

  const parsed = parseFlags(argv, RM_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  if (parsed.positionals.length === 0) {
    return { kind: "refused", cause: "parse-error", detail: "rm requires at least one positional path" };
  }

  const semantics = {
    reads: [],
    writes: parsed.positionals,
    network: [],
    envMutations: [],
  } as const;

  const recursive = RECURSIVE_FLAGS.some((f) => parsed.flags.has(f));
  if (recursive) {
    return { kind: "partial", semantics, reason: "recursive-subtree-root" };
  }
  return { kind: "complete", semantics };
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/rm.test.ts`
Expected: 10 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/rm.ts \
        packages/lib/bash-ast/src/specs/rm.test.ts
git commit -m "feat(bash-ast): add specRm — destructive write of positional paths (#1662)"
```

---

### Task 8: specChmod — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/chmod.test.ts`

Behaviour:
- First positional is mode (NOT a path), remaining are paths → `writes`.
- `-R` recursive → `partial`.
- Missing mode or path → refused.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { specChmod } from "../chmod.js";

describe("specChmod — non-recursive", () => {
  test("returns complete with paths as writes (mode excluded)", () => {
    const result = specChmod(["chmod", "755", "foo", "bar"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["foo", "bar"]);
    expect(result.semantics.reads).toEqual([]);
  });

  test("recognises -f and -v", () => {
    const result = specChmod(["chmod", "-f", "-v", "+x", "x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["x"]);
  });

  test("treats -- as end-of-options", () => {
    const result = specChmod(["chmod", "--", "755", "-x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["-x"]);
  });
});

describe("specChmod — recursive (partial)", () => {
  test("with -R returns partial recursive-subtree-root", () => {
    const result = specChmod(["chmod", "-R", "755", "dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root");
    expect(result.semantics.writes).toEqual(["dir"]);
  });
});

describe("specChmod — refused", () => {
  test("missing mode and path", () => {
    const result = specChmod(["chmod"]);
    expect(result.kind).toBe("refused");
  });

  test("missing path (only mode)", () => {
    const result = specChmod(["chmod", "755"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("unknown flag", () => {
    const result = specChmod(["chmod", "-z", "755", "x"]);
    expect(result.kind).toBe("refused");
  });

  test("wrong command name", () => {
    const result = specChmod(["ls", "755", "x"]);
    expect(result.kind).toBe("refused");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/chmod.test.ts`
Expected: cannot find module.

---

### Task 9: specChmod — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/chmod.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import { parseFlags } from "./parse-flags.js";
import type { SpecResult } from "./types.js";

const CHMOD_ALLOW = {
  bool: new Set(["R", "v", "f"]),
  value: new Set<string>(),
};

export function specChmod(argv: readonly string[]): SpecResult {
  if (argv[0] !== "chmod") {
    return { kind: "refused", cause: "parse-error", detail: "spec dispatched on non-chmod argv" };
  }

  const parsed = parseFlags(argv, CHMOD_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  if (parsed.positionals.length < 2) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: "chmod requires a mode and at least one path",
    };
  }

  const writes = parsed.positionals.slice(1);
  const semantics = { reads: [], writes, network: [], envMutations: [] } as const;

  if (parsed.flags.has("R")) {
    return { kind: "partial", semantics, reason: "recursive-subtree-root" };
  }
  return { kind: "complete", semantics };
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/chmod.test.ts`
Expected: 8 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/chmod.ts \
        packages/lib/bash-ast/src/specs/chmod.test.ts
git commit -m "feat(bash-ast): add specChmod — metadata write on path positionals (#1662)"
```

---

### Task 10: specChown — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/chown.test.ts`

Same shape as chmod; first positional is owner spec.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { specChown } from "../chown.js";

describe("specChown — non-recursive", () => {
  test("returns complete with paths as writes (owner excluded)", () => {
    const result = specChown(["chown", "alice:wheel", "foo", "bar"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["foo", "bar"]);
  });

  test("treats -- as end-of-options", () => {
    const result = specChown(["chown", "--", "root", "-x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["-x"]);
  });
});

describe("specChown — recursive (partial)", () => {
  test("with -R returns partial recursive-subtree-root", () => {
    const result = specChown(["chown", "-R", "alice", "dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root");
    expect(result.semantics.writes).toEqual(["dir"]);
  });
});

describe("specChown — refused", () => {
  test("missing both", () => {
    expect(specChown(["chown"]).kind).toBe("refused");
  });

  test("missing path", () => {
    expect(specChown(["chown", "alice"]).kind).toBe("refused");
  });

  test("unknown flag", () => {
    expect(specChown(["chown", "-z", "alice", "x"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specChown(["ls", "alice", "x"]).kind).toBe("refused");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/chown.test.ts`
Expected: cannot find module.

---

### Task 11: specChown — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/chown.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import { parseFlags } from "./parse-flags.js";
import type { SpecResult } from "./types.js";

const CHOWN_ALLOW = {
  bool: new Set(["R", "v", "f"]),
  value: new Set<string>(),
};

export function specChown(argv: readonly string[]): SpecResult {
  if (argv[0] !== "chown") {
    return { kind: "refused", cause: "parse-error", detail: "spec dispatched on non-chown argv" };
  }

  const parsed = parseFlags(argv, CHOWN_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  if (parsed.positionals.length < 2) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: "chown requires an owner spec and at least one path",
    };
  }

  const writes = parsed.positionals.slice(1);
  const semantics = { reads: [], writes, network: [], envMutations: [] } as const;

  if (parsed.flags.has("R")) {
    return { kind: "partial", semantics, reason: "recursive-subtree-root" };
  }
  return { kind: "complete", semantics };
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/chown.test.ts`
Expected: 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/chown.ts \
        packages/lib/bash-ast/src/specs/chown.test.ts
git commit -m "feat(bash-ast): add specChown — owner change on path positionals (#1662)"
```

---

### Task 12: specMv — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/mv.test.ts`

Behaviour (recap from spec doc):
- `-T src dst` (exactly 2 positionals): `complete`, `writes: [src, dst]`, `reads: []`.
- `-t DIR src...`: `complete`, `writes: [...srcs, ...DIR/<basename(src)>]`, `reads: []`. Basename failure → refused.
- `mv src... dst` (no -T/-t): `partial`, `reason: "cp-mv-dest-may-be-directory"`, `writes: [...srcs, dst, ...dst/<basename(src)>]`, `reads: []`.
- src always in writes (move is destructive on src).
- Unknown flag → refused.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { specMv } from "../mv.js";

describe("specMv — -T form (complete)", () => {
  test("two positionals with -T", () => {
    const result = specMv(["mv", "-T", "src", "dst"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["src", "dst"]);
    expect(result.semantics.reads).toEqual([]);
  });

  test("-T with !=2 positionals refused", () => {
    expect(specMv(["mv", "-T", "a"]).kind).toBe("refused");
    expect(specMv(["mv", "-T", "a", "b", "c"]).kind).toBe("refused");
  });
});

describe("specMv — -t DIR form (complete)", () => {
  test("derives DIR/basename for each src", () => {
    const result = specMv(["mv", "-t", "out", "a", "b/c"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["a", "b/c", "out/a", "out/c"]);
  });

  test("strips trailing slash from src", () => {
    const result = specMv(["mv", "-t", "out", "src/"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["src/", "out/src"]);
  });

  test("src that is / refuses", () => {
    const result = specMv(["mv", "-t", "out", "/"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });
});

describe("specMv — destination-last (partial)", () => {
  test("partial with cp-mv-dest-may-be-directory", () => {
    const result = specMv(["mv", "foo.txt", "out/dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("cp-mv-dest-may-be-directory");
    expect(result.semantics.writes).toEqual(["foo.txt", "out/dir", "out/dir/foo.txt"]);
  });

  test("multiple srcs over-approximated", () => {
    const result = specMv(["mv", "a", "b", "out"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.writes).toEqual(["a", "b", "out", "out/a", "out/b"]);
  });
});

describe("specMv — refused", () => {
  test("zero positionals", () => {
    expect(specMv(["mv"]).kind).toBe("refused");
  });

  test("one positional (no destination)", () => {
    expect(specMv(["mv", "src"]).kind).toBe("refused");
  });

  test("unknown flag", () => {
    expect(specMv(["mv", "-z", "a", "b"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specMv(["cp", "a", "b"]).kind).toBe("refused");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/mv.test.ts`
Expected: cannot find module.

---

### Task 13: specMv — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/mv.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import { parseFlags } from "./parse-flags.js";
import { posixBasename } from "./posix-basename.js";
import type { SpecResult } from "./types.js";

const MV_ALLOW = {
  bool: new Set(["f", "i", "n", "v", "T"]),
  value: new Set(["t"]),
};

export function specMv(argv: readonly string[]): SpecResult {
  if (argv[0] !== "mv") {
    return { kind: "refused", cause: "parse-error", detail: "spec dispatched on non-mv argv" };
  }

  const parsed = parseFlags(argv, MV_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  const tValue = parsed.flags.get("t");
  const hasT = parsed.flags.has("T");

  if (hasT) {
    if (parsed.positionals.length !== 2) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: "mv -T requires exactly two positionals",
      };
    }
    const [src, dst] = parsed.positionals as readonly [string, string];
    const semantics = { reads: [], writes: [src, dst], network: [], envMutations: [] } as const;
    return { kind: "complete", semantics };
  }

  if (typeof tValue === "string") {
    if (parsed.positionals.length === 0) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: "mv -t DIR requires at least one source",
      };
    }
    const derivedRaw = parsed.positionals.map((src) => ({ src, base: posixBasename(src) }));
    const failed = derivedRaw.find((d) => !d.base.ok);
    if (failed) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: `unable to derive basename for src '${failed.src}'`,
      };
    }
    const writes = [
      ...parsed.positionals,
      ...derivedRaw.map((d) => `${tValue}/${d.base.ok ? d.base.value : ""}`),
    ];
    const semantics = { reads: [], writes, network: [], envMutations: [] } as const;
    return { kind: "complete", semantics };
  }

  // Destination-last form
  if (parsed.positionals.length < 2) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: "mv requires source(s) and a destination",
    };
  }
  const dst = parsed.positionals[parsed.positionals.length - 1];
  if (dst === undefined) {
    return { kind: "refused", cause: "parse-error", detail: "mv destination missing" };
  }
  const srcs = parsed.positionals.slice(0, -1);
  const derivedRaw = srcs.map((src) => ({ src, base: posixBasename(src) }));
  const failed = derivedRaw.find((d) => !d.base.ok);
  if (failed) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `unable to derive basename for src '${failed.src}'`,
    };
  }
  const writes = [
    ...srcs,
    dst,
    ...derivedRaw.map((d) => `${dst}/${d.base.ok ? d.base.value : ""}`),
  ];
  const semantics = { reads: [], writes, network: [], envMutations: [] } as const;
  return { kind: "partial", semantics, reason: "cp-mv-dest-may-be-directory" };
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/mv.test.ts`
Expected: 11 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/mv.ts \
        packages/lib/bash-ast/src/specs/mv.test.ts
git commit -m "feat(bash-ast): add specMv — destructive move with src always in writes (#1662)"
```

---

### Task 14: specCp — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/cp.test.ts`

Behaviour:
- `-T src dst` (exactly 2 positionals): `complete`, `reads: [src], writes: [dst]`.
- `-t DIR src...`: `complete`, `reads: [...srcs], writes: ["DIR/<basename(src)>" for each src]`. Basename failure → refused.
- `cp src... dst` (no -T/-t): `partial`, `reason: "cp-mv-dest-may-be-directory"`, `reads: [...srcs]`, `writes: [dst, ...("dst/<basename(src)>" for each src)]`.
- Recursive (`-r`/`-R`/`-a`) flips kind to `partial`. Reason is `"recursive-subtree-root"`, OR the dest-may-be-directory reason joined with `;` if both apply.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { specCp } from "../cp.js";

describe("specCp — -T form (complete)", () => {
  test("two positionals with -T", () => {
    const result = specCp(["cp", "-T", "src", "dst"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual(["src"]);
    expect(result.semantics.writes).toEqual(["dst"]);
  });

  test("-T with !=2 positionals refused", () => {
    expect(specCp(["cp", "-T", "a"]).kind).toBe("refused");
    expect(specCp(["cp", "-T", "a", "b", "c"]).kind).toBe("refused");
  });
});

describe("specCp — -t DIR form (complete)", () => {
  test("derives DIR/basename for each src", () => {
    const result = specCp(["cp", "-t", "out", "a", "b"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual(["a", "b"]);
    expect(result.semantics.writes).toEqual(["out/a", "out/b"]);
  });

  test("strips trailing slash on src basename", () => {
    const result = specCp(["cp", "-t", "out", "src/"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out/src"]);
  });

  test("src that is / refuses", () => {
    const result = specCp(["cp", "-t", "out", "/"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });
});

describe("specCp — destination-last (partial)", () => {
  test("partial with cp-mv-dest-may-be-directory and over-approx writes", () => {
    const result = specCp(["cp", "foo.txt", "out/dir"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("cp-mv-dest-may-be-directory");
    expect(result.semantics.reads).toEqual(["foo.txt"]);
    expect(result.semantics.writes).toEqual(["out/dir", "out/dir/foo.txt"]);
  });

  test("multiple sources", () => {
    const result = specCp(["cp", "a", "b", "out"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.reads).toEqual(["a", "b"]);
    expect(result.semantics.writes).toEqual(["out", "out/a", "out/b"]);
  });
});

describe("specCp — recursive interaction", () => {
  test("-r alone with destination-last → partial; reason joins both", () => {
    const result = specCp(["cp", "-r", "src", "dst"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root;cp-mv-dest-may-be-directory");
  });

  test("-R with -T → partial recursive-subtree-root only", () => {
    const result = specCp(["cp", "-R", "-T", "src", "dst"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root");
    expect(result.semantics.reads).toEqual(["src"]);
    expect(result.semantics.writes).toEqual(["dst"]);
  });

  test("-a with -t → partial recursive-subtree-root only", () => {
    const result = specCp(["cp", "-a", "-t", "out", "a"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("recursive-subtree-root");
    expect(result.semantics.writes).toEqual(["out/a"]);
  });
});

describe("specCp — refused", () => {
  test("zero positionals", () => {
    expect(specCp(["cp"]).kind).toBe("refused");
  });

  test("one positional", () => {
    expect(specCp(["cp", "src"]).kind).toBe("refused");
  });

  test("unknown flag", () => {
    expect(specCp(["cp", "-z", "a", "b"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specCp(["mv", "a", "b"]).kind).toBe("refused");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/cp.test.ts`
Expected: cannot find module.

---

### Task 15: specCp — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/cp.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import { parseFlags } from "./parse-flags.js";
import { posixBasename } from "./posix-basename.js";
import type { SpecResult } from "./types.js";

const CP_ALLOW = {
  bool: new Set(["r", "R", "f", "i", "p", "a", "v", "T"]),
  value: new Set(["t"]),
};

const RECURSIVE_FLAGS = ["r", "R", "a"] as const;

export function specCp(argv: readonly string[]): SpecResult {
  if (argv[0] !== "cp") {
    return { kind: "refused", cause: "parse-error", detail: "spec dispatched on non-cp argv" };
  }

  const parsed = parseFlags(argv, CP_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  const recursive = RECURSIVE_FLAGS.some((f) => parsed.flags.has(f));
  const tValue = parsed.flags.get("t");
  const hasT = parsed.flags.has("T");

  if (hasT) {
    if (parsed.positionals.length !== 2) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: "cp -T requires exactly two positionals",
      };
    }
    const [src, dst] = parsed.positionals as readonly [string, string];
    const semantics = { reads: [src], writes: [dst], network: [], envMutations: [] } as const;
    return recursive
      ? { kind: "partial", semantics, reason: "recursive-subtree-root" }
      : { kind: "complete", semantics };
  }

  if (typeof tValue === "string") {
    if (parsed.positionals.length === 0) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: "cp -t DIR requires at least one source",
      };
    }
    const derived = parsed.positionals.map((src) => ({ src, base: posixBasename(src) }));
    const failed = derived.find((d) => !d.base.ok);
    if (failed) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: `unable to derive basename for src '${failed.src}'`,
      };
    }
    const writes = derived.map((d) => `${tValue}/${d.base.ok ? d.base.value : ""}`);
    const semantics = {
      reads: parsed.positionals,
      writes,
      network: [],
      envMutations: [],
    } as const;
    return recursive
      ? { kind: "partial", semantics, reason: "recursive-subtree-root" }
      : { kind: "complete", semantics };
  }

  // Destination-last form
  if (parsed.positionals.length < 2) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: "cp requires source(s) and a destination",
    };
  }
  const dst = parsed.positionals[parsed.positionals.length - 1];
  if (dst === undefined) {
    return { kind: "refused", cause: "parse-error", detail: "cp destination missing" };
  }
  const srcs = parsed.positionals.slice(0, -1);
  const derived = srcs.map((src) => ({ src, base: posixBasename(src) }));
  const failed = derived.find((d) => !d.base.ok);
  if (failed) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `unable to derive basename for src '${failed.src}'`,
    };
  }
  const writes = [
    dst,
    ...derived.map((d) => `${dst}/${d.base.ok ? d.base.value : ""}`),
  ];
  const semantics = { reads: srcs, writes, network: [], envMutations: [] } as const;
  const reason = recursive
    ? "recursive-subtree-root;cp-mv-dest-may-be-directory"
    : "cp-mv-dest-may-be-directory";
  return { kind: "partial", semantics, reason };
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/cp.test.ts`
Expected: 13 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/cp.ts \
        packages/lib/bash-ast/src/specs/cp.test.ts
git commit -m "feat(bash-ast): add specCp — read src(s), write dst plus over-approx leaves (#1662)"
```

---

### Task 16: specTar — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/tar.test.ts`

Behaviour:
- Mode flag `-c`/`-x`/`-t` MUST be exactly one. Multiple → refused. None → refused.
- `-f FILE` is required. Missing → refused (no stdin form).
- `-c` (create): `complete`, `writes: [archive]`, `reads: [...positionals]`.
- `-t` (list): `complete`, `reads: [archive]`, no writes.
- `-x` (extract): `partial`, `reason: "tar-extract-targets-in-archive"`, `reads: [archive]`, `writes: []`.
- Bundled or separate mode flags both work (`tar -xf foo.tar`, `tar -x -f foo.tar`).

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { specTar } from "../tar.js";

describe("specTar — create (-c)", () => {
  test("returns complete with archive in writes and files in reads", () => {
    const result = specTar(["tar", "-c", "-f", "out.tar", "a.txt", "b.txt"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out.tar"]);
    expect(result.semantics.reads).toEqual(["a.txt", "b.txt"]);
  });

  test("bundled -cf works", () => {
    const result = specTar(["tar", "-cf", "out.tar", "a.txt"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out.tar"]);
  });
});

describe("specTar — list (-t)", () => {
  test("returns complete with archive in reads, no writes", () => {
    const result = specTar(["tar", "-tf", "in.tar"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual(["in.tar"]);
    expect(result.semantics.writes).toEqual([]);
  });
});

describe("specTar — extract (-x, partial)", () => {
  test("returns partial with archive in reads and empty writes", () => {
    const result = specTar(["tar", "-xf", "in.tar"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("tar-extract-targets-in-archive");
    expect(result.semantics.reads).toEqual(["in.tar"]);
    expect(result.semantics.writes).toEqual([]);
  });

  test("with -C DIR — archive still in reads, writes empty", () => {
    const result = specTar(["tar", "-x", "-f", "in.tar", "-C", "/dest"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.reads).toEqual(["in.tar"]);
    expect(result.semantics.writes).toEqual([]);
  });
});

describe("specTar — refused", () => {
  test("multiple mode flags", () => {
    const result = specTar(["tar", "-c", "-x", "-f", "in.tar"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("no mode flag", () => {
    const result = specTar(["tar", "-f", "in.tar"]);
    expect(result.kind).toBe("refused");
  });

  test("no -f (stdin form)", () => {
    const result = specTar(["tar", "-c"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("unknown flag", () => {
    expect(specTar(["tar", "-c", "-z", "-f", "x.tar"]).kind).not.toBe("refused");
    // -z IS recognised (gzip). Use a truly unknown one:
    expect(specTar(["tar", "-c", "-Q", "-f", "x.tar"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specTar(["zip", "-c", "-f", "x"]).kind).toBe("refused");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/tar.test.ts`
Expected: cannot find module.

---

### Task 17: specTar — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/tar.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import { parseFlags } from "./parse-flags.js";
import type { SpecResult } from "./types.js";

const TAR_ALLOW = {
  bool: new Set(["x", "c", "t", "z", "j", "v"]),
  value: new Set(["f", "C"]),
};

export function specTar(argv: readonly string[]): SpecResult {
  if (argv[0] !== "tar") {
    return { kind: "refused", cause: "parse-error", detail: "spec dispatched on non-tar argv" };
  }

  const parsed = parseFlags(argv, TAR_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  const modes = (["x", "c", "t"] as const).filter((m) => parsed.flags.has(m));
  if (modes.length !== 1) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail:
        modes.length === 0
          ? "tar requires exactly one mode flag (-x, -c, or -t)"
          : `tar received conflicting mode flags: ${modes.map((m) => `-${m}`).join(", ")}`,
    };
  }

  const archive = parsed.flags.get("f");
  if (typeof archive !== "string") {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: "tar requires -f FILE (stdin form not supported by this spec)",
    };
  }

  const mode = modes[0];

  if (mode === "c") {
    const semantics = {
      reads: parsed.positionals,
      writes: [archive],
      network: [],
      envMutations: [],
    } as const;
    return { kind: "complete", semantics };
  }

  if (mode === "t") {
    const semantics = {
      reads: [archive],
      writes: [],
      network: [],
      envMutations: [],
    } as const;
    return { kind: "complete", semantics };
  }

  // mode === "x"
  const semantics = {
    reads: [archive],
    writes: [],
    network: [],
    envMutations: [],
  } as const;
  return { kind: "partial", semantics, reason: "tar-extract-targets-in-archive" };
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/tar.test.ts`
Expected: 9 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/tar.ts \
        packages/lib/bash-ast/src/specs/tar.test.ts
git commit -m "feat(bash-ast): add specTar — create/list complete; extract partial (#1662)"
```

---

### Task 18: specCurl — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/curl.test.ts`

Behaviour (recap):
- Each URL parsed via `URL`. Schemes:
  - `http:`, `https:` → `network: { kind: "http", target, host }`.
  - `ftp:`, `ftps:` → `network: { kind: "ftp", target, host }`.
  - `scp:`, `sftp:` → `refused: unsupported-form` (SSH trust boundary).
  - `file:` only with empty authority → `reads: [URL.pathname]`.
  - URL parse failure → `refused: parse-error`.
  - Other schemes → `refused: unsupported-form`.
- `-o FILE` → `writes: [FILE]`. `-O` → no writes; sets partial reason `curl-O-derived-basename`.
- `-d @file` → `reads: [file]`; inline data does not.
- `-L` sets partial reason `curl-follows-redirects`. Both -L and -O → reasons joined by `;`.
- Refused flags: `--config`/`-K`, `--next`, `-T`.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { specCurl } from "../curl.js";

describe("specCurl — http(s)", () => {
  test("plain GET → complete network http", () => {
    const result = specCurl(["curl", "https://example.com/path"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    const n = result.semantics.network[0];
    expect(n).toBeDefined();
    if (!n) return;
    expect(n.kind).toBe("http");
    expect(n.target).toBe("https://example.com/path");
    expect(n.host).toBe("example.com");
  });

  test("non-default port preserved in host", () => {
    const result = specCurl(["curl", "https://example.com:8443/x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.network[0]?.host).toBe("example.com:8443");
  });

  test("with -o FILE → file in writes", () => {
    const result = specCurl(["curl", "-o", "out.bin", "https://example.com/"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.writes).toEqual(["out.bin"]);
  });

  test("with -L sets partial curl-follows-redirects", () => {
    const result = specCurl(["curl", "-L", "https://example.com/"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("curl-follows-redirects");
  });

  test("with -O sets partial curl-O-derived-basename", () => {
    const result = specCurl(["curl", "-O", "https://example.com/x.tar"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("curl-O-derived-basename");
    expect(result.semantics.writes).toEqual([]);
  });

  test("-L and -O combine reasons joined by ;", () => {
    const result = specCurl(["curl", "-L", "-O", "https://example.com/x"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("curl-follows-redirects;curl-O-derived-basename");
  });

  test("with -d @file → file in reads", () => {
    const result = specCurl(["curl", "-d", "@body.json", "https://api/x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual(["body.json"]);
  });

  test("inline -d data does NOT produce a read", () => {
    const result = specCurl(["curl", "-d", "key=val", "https://api/x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual([]);
  });
});

describe("specCurl — ftp(s)", () => {
  test("ftp scheme → network kind ftp", () => {
    const result = specCurl(["curl", "ftp://files.example.com/x"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.network[0]?.kind).toBe("ftp");
  });
});

describe("specCurl — file://", () => {
  test("file:///path → reads [path], no network", () => {
    const result = specCurl(["curl", "file:///etc/passwd"]);
    expect(result.kind).toBe("complete");
    if (result.kind !== "complete") return;
    expect(result.semantics.reads).toEqual(["/etc/passwd"]);
    expect(result.semantics.network).toEqual([]);
  });

  test("file://host/path → refused unsupported-form (non-empty authority)", () => {
    const result = specCurl(["curl", "file://host/path"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("unsupported-form");
  });
});

describe("specCurl — refused schemes", () => {
  test("scp://", () => {
    const result = specCurl(["curl", "scp://host/path"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("unsupported-form");
  });

  test("sftp://", () => {
    expect(specCurl(["curl", "sftp://host/p"]).kind).toBe("refused");
  });

  test("gopher:// → unsupported-form", () => {
    const result = specCurl(["curl", "gopher://host/x"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("unsupported-form");
  });
});

describe("specCurl — refused flags / parse errors", () => {
  test("--config refused", () => {
    expect(specCurl(["curl", "--config", "/tmp/c", "https://x"]).kind).toBe("refused");
  });

  test("-K refused", () => {
    expect(specCurl(["curl", "-K", "/tmp/c", "https://x"]).kind).toBe("refused");
  });

  test("--next refused", () => {
    expect(specCurl(["curl", "--next", "https://x"]).kind).toBe("refused");
  });

  test("-T refused", () => {
    expect(specCurl(["curl", "-T", "f", "https://x"]).kind).toBe("refused");
  });

  test("malformed URL → parse-error", () => {
    const result = specCurl(["curl", "http://[invalid"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("no URL positional", () => {
    expect(specCurl(["curl"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specCurl(["wget", "https://x"]).kind).toBe("refused");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/curl.test.ts`
Expected: cannot find module.

---

### Task 19: specCurl — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/curl.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import { parseFlags } from "./parse-flags.js";
import type { CommandSemantics, NetworkAccess, SpecResult } from "./types.js";

const CURL_ALLOW = {
  bool: new Set(["O", "L", "s", "i"]),
  value: new Set(["o", "output", "X", "d", "data", "H"]),
};

export function specCurl(argv: readonly string[]): SpecResult {
  if (argv[0] !== "curl") {
    return { kind: "refused", cause: "parse-error", detail: "spec dispatched on non-curl argv" };
  }

  // Reject explicit refused-by-design flags BEFORE generic flag parsing
  // (parseFlags would call them "unknown long flag", which is correct
  // but loses the intent). Accept either `--config X`, `--config=X`, or `-K X`.
  for (const tok of argv.slice(1)) {
    if (tok === "--config" || tok.startsWith("--config=") || tok === "-K" || tok === "--next") {
      return {
        kind: "refused",
        cause: "unsupported-form",
        detail: `curl flag ${tok} can rewrite request behavior; refused`,
      };
    }
    if (tok === "-T" || tok === "--upload-file" || tok.startsWith("--upload-file=")) {
      return {
        kind: "refused",
        cause: "unsupported-form",
        detail: "curl -T/--upload-file uploads local files; refused (model with explicit reads)",
      };
    }
  }

  const parsed = parseFlags(argv, CURL_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  if (parsed.positionals.length === 0) {
    return { kind: "refused", cause: "parse-error", detail: "curl requires at least one URL" };
  }

  const reads: string[] = [];
  const writes: string[] = [];
  const network: NetworkAccess[] = [];
  const reasons: string[] = [];

  for (const url of parsed.positionals) {
    const dispatched = dispatchUrl(url);
    if (dispatched.kind === "refused") return dispatched;
    if (dispatched.network) network.push(dispatched.network);
    if (dispatched.read) reads.push(dispatched.read);
  }

  // -o / --output → write
  const outFile = parsed.flags.get("o") ?? parsed.flags.get("output");
  if (typeof outFile === "string") writes.push(outFile);

  // -O → partial (URL-derived basename)
  if (parsed.flags.has("O")) reasons.push("curl-O-derived-basename");

  // -L → partial (follows redirects)
  if (parsed.flags.has("L")) reasons.unshift("curl-follows-redirects");

  // -d / --data → reads if @file form
  for (const key of ["d", "data"] as const) {
    const v = parsed.flags.get(key);
    if (typeof v === "string" && v.startsWith("@")) reads.push(v.slice(1));
  }

  const semantics: CommandSemantics = { reads, writes, network, envMutations: [] };

  if (reasons.length > 0) {
    return { kind: "partial", semantics, reason: reasons.join(";") };
  }
  return { kind: "complete", semantics };
}

interface UrlDispatchOk {
  readonly kind: "ok";
  readonly network?: NetworkAccess;
  readonly read?: string;
}

function dispatchUrl(
  raw: string,
):
  | UrlDispatchOk
  | { readonly kind: "refused"; readonly cause: "parse-error" | "unsupported-form"; readonly detail: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (err) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `invalid URL '${raw}': ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  switch (url.protocol) {
    case "http:":
    case "https:":
      return { kind: "ok", network: { kind: "http", target: raw, host: url.host } };
    case "ftp:":
    case "ftps:":
      return { kind: "ok", network: { kind: "ftp", target: raw, host: url.host } };
    case "scp:":
    case "sftp:":
      return {
        kind: "refused",
        cause: "unsupported-form",
        detail: `${url.protocol} crosses SSH trust boundary; same default ssh_config exposure as ssh/scp`,
      };
    case "file:": {
      if (url.host !== "") {
        return {
          kind: "refused",
          cause: "unsupported-form",
          detail: "file:// with non-empty authority is ambiguous; use file:///<path>",
        };
      }
      return { kind: "ok", read: url.pathname };
    }
    default:
      return {
        kind: "refused",
        cause: "unsupported-form",
        detail: `unsupported URL scheme: ${url.protocol}`,
      };
  }
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/curl.test.ts`
Expected: 21 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/curl.ts \
        packages/lib/bash-ast/src/specs/curl.test.ts
git commit -m "feat(bash-ast): add specCurl with URL scheme dispatch + redirect signaling (#1662)"
```

---

### Task 20: specWget — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/wget.test.ts`

Behaviour:
- Same URL scheme dispatch as curl, but smaller scheme set: `http:`/`https:`/`ftp:`/`ftps:`. Anything else → refused.
- ALWAYS `partial` (wget follows redirects by default), `reason: "wget-follows-redirects"`.
- `-O FILE` → `writes: [FILE]`. Without `-O`, `writes: []`.
- `-i`/`--input-file` → refused.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { specWget } from "../wget.js";

describe("specWget — http(s)", () => {
  test("plain wget → partial with wget-follows-redirects", () => {
    const result = specWget(["wget", "https://example.com/x"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.reason).toBe("wget-follows-redirects");
    expect(result.semantics.network[0]?.host).toBe("example.com");
    expect(result.semantics.writes).toEqual([]);
  });

  test("with -O FILE → file in writes", () => {
    const result = specWget(["wget", "-O", "out.bin", "https://example.com/"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.writes).toEqual(["out.bin"]);
  });

  test("port preserved in host", () => {
    const result = specWget(["wget", "https://example.com:8443/x"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.network[0]?.host).toBe("example.com:8443");
  });
});

describe("specWget — ftp(s)", () => {
  test("ftp scheme", () => {
    const result = specWget(["wget", "ftp://files.example.com/x"]);
    expect(result.kind).toBe("partial");
    if (result.kind !== "partial") return;
    expect(result.semantics.network[0]?.kind).toBe("ftp");
  });
});

describe("specWget — refused", () => {
  test("file:// scheme refused", () => {
    expect(specWget(["wget", "file:///etc/passwd"]).kind).toBe("refused");
  });

  test("gopher:// scheme refused", () => {
    expect(specWget(["wget", "gopher://x"]).kind).toBe("refused");
  });

  test("malformed URL → parse-error", () => {
    const result = specWget(["wget", "http://[invalid"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("parse-error");
  });

  test("-i refused", () => {
    expect(specWget(["wget", "-i", "list.txt"]).kind).toBe("refused");
  });

  test("--input-file refused", () => {
    expect(specWget(["wget", "--input-file", "list.txt"]).kind).toBe("refused");
  });

  test("no URL", () => {
    expect(specWget(["wget"]).kind).toBe("refused");
  });

  test("wrong command name", () => {
    expect(specWget(["curl", "https://x"]).kind).toBe("refused");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/wget.test.ts`
Expected: cannot find module.

---

### Task 21: specWget — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/wget.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import { parseFlags } from "./parse-flags.js";
import type { CommandSemantics, NetworkAccess, SpecResult } from "./types.js";

const WGET_ALLOW = {
  bool: new Set(["q", "c", "N"]),
  value: new Set(["O"]),
};

export function specWget(argv: readonly string[]): SpecResult {
  if (argv[0] !== "wget") {
    return { kind: "refused", cause: "parse-error", detail: "spec dispatched on non-wget argv" };
  }

  for (const tok of argv.slice(1)) {
    if (tok === "-i" || tok === "--input-file" || tok.startsWith("--input-file=")) {
      return {
        kind: "refused",
        cause: "unsupported-form",
        detail: "wget -i/--input-file reads URLs from a file; refused",
      };
    }
  }

  const parsed = parseFlags(argv, WGET_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  if (parsed.positionals.length === 0) {
    return { kind: "refused", cause: "parse-error", detail: "wget requires at least one URL" };
  }

  const network: NetworkAccess[] = [];
  for (const raw of parsed.positionals) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch (err) {
      return {
        kind: "refused",
        cause: "parse-error",
        detail: `invalid URL '${raw}': ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    switch (url.protocol) {
      case "http:":
      case "https:":
        network.push({ kind: "http", target: raw, host: url.host });
        break;
      case "ftp:":
      case "ftps:":
        network.push({ kind: "ftp", target: raw, host: url.host });
        break;
      default:
        return {
          kind: "refused",
          cause: "unsupported-form",
          detail: `unsupported URL scheme: ${url.protocol}`,
        };
    }
  }

  const writes: string[] = [];
  const outFile = parsed.flags.get("O");
  if (typeof outFile === "string") writes.push(outFile);

  const semantics: CommandSemantics = { reads: [], writes, network, envMutations: [] };
  return { kind: "partial", semantics, reason: "wget-follows-redirects" };
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/wget.test.ts`
Expected: 11 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/wget.ts \
        packages/lib/bash-ast/src/specs/wget.test.ts
git commit -m "feat(bash-ast): add specWget — always partial; URL scheme dispatch (#1662)"
```

---

### Task 22: specScp — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/scp.test.ts`

Always `refused`, `cause: "unsupported-form"`. `detail` discriminates:
- Trust-boundary flag (`-o`, `-F`, `-J`) → detail names the flag.
- Otherwise → detail mentions "default ssh_config".

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { specScp } from "../scp.js";

describe("specScp — always refused", () => {
  test("plain scp host:path local form", () => {
    const result = specScp(["scp", "host:src", "."]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("unsupported-form");
    expect(result.detail).toMatch(/default ssh_config/);
  });

  test("plain scp local to host", () => {
    const result = specScp(["scp", "src.txt", "host:/dst"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/default ssh_config/);
  });

  test("with -o flag — detail names the flag", () => {
    const result = specScp(["scp", "-o", "ProxyCommand=nc evil 22", "src", "host:dst"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-o/);
  });

  test("with -F flag", () => {
    const result = specScp(["scp", "-F", "/tmp/cfg", "src", "host:dst"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-F/);
  });

  test("with -J flag", () => {
    const result = specScp(["scp", "-J", "jumphost", "src", "host:dst"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-J/);
  });

  test("never returns complete or partial — fuzz with permutations", () => {
    const cases = [
      ["scp"],
      ["scp", "src"],
      ["scp", "-r", "src", "host:dst"],
      ["scp", "-i", "/key", "src", "host:dst"],
      ["scp", "-P", "2222", "src", "host:dst"],
    ];
    for (const argv of cases) {
      const result = specScp(argv);
      expect(result.kind).toBe("refused");
    }
  });

  test("wrong command name", () => {
    expect(specScp(["ssh", "host"]).kind).toBe("refused");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/scp.test.ts`
Expected: cannot find module.

---

### Task 23: specScp — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/scp.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import type { SpecResult } from "./types.js";

const TRUST_BOUNDARY_PREFIXES = ["-o", "-F", "-J"] as const;

export function specScp(argv: readonly string[]): SpecResult {
  if (argv[0] !== "scp") {
    return { kind: "refused", cause: "parse-error", detail: "spec dispatched on non-scp argv" };
  }

  const offending = findTrustBoundaryFlag(argv);
  if (offending !== null) {
    return {
      kind: "refused",
      cause: "unsupported-form",
      detail: `scp ${offending} can rewrite endpoint or pull arbitrary local I/O via ssh_config`,
    };
  }

  return {
    kind: "refused",
    cause: "unsupported-form",
    detail: "plain scp may invoke ProxyCommand/Include/IdentityFile via default ssh_config",
  };
}

function findTrustBoundaryFlag(argv: readonly string[]): string | null {
  for (const tok of argv.slice(1)) {
    for (const prefix of TRUST_BOUNDARY_PREFIXES) {
      if (tok === prefix || (tok.startsWith(prefix) && tok.length > prefix.length)) {
        return prefix;
      }
    }
  }
  return null;
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/scp.test.ts`
Expected: 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/scp.ts \
        packages/lib/bash-ast/src/specs/scp.test.ts
git commit -m "feat(bash-ast): add specScp — always refused (default ssh_config exposure) (#1662)"
```

---

### Task 24: specSsh — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/ssh.test.ts`

Always `refused`. `detail` discriminates:
- Trust-boundary flag (`-o`, `-F`, `-J`, `-D`, `-L`, `-R`) → names the flag.
- Trailing remote command after the host → "remote command requires exact-argv Run rule".
- Otherwise → "default ssh_config" wording.

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { specSsh } from "../ssh.js";

describe("specSsh — always refused", () => {
  test("plain ssh host", () => {
    const result = specSsh(["ssh", "user@host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.cause).toBe("unsupported-form");
    expect(result.detail).toMatch(/default ssh_config/);
  });

  test("ssh host with remote command — detail mentions remote command", () => {
    const result = specSsh(["ssh", "host", "rm -rf /"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/remote command/);
  });

  test("ssh -i KEY host — still refused (default config exposure)", () => {
    const result = specSsh(["ssh", "-i", "/key", "host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/default ssh_config/);
  });

  test("ssh -o ProxyCommand=… → detail names -o", () => {
    const result = specSsh(["ssh", "-o", "ProxyCommand=nc evil 22", "host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-o/);
  });

  test("ssh -F /tmp/cfg host → detail names -F", () => {
    const result = specSsh(["ssh", "-F", "/tmp/cfg", "host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-F/);
  });

  test("ssh -J jump host → detail names -J", () => {
    const result = specSsh(["ssh", "-J", "jumphost", "host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-J/);
  });

  test("ssh -L 8080:internal:80 host → detail names port-forward", () => {
    const result = specSsh(["ssh", "-L", "8080:internal:80", "host"]);
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.detail).toMatch(/-L/);
  });

  test("ssh -D port host → detail names port-forward", () => {
    expect(specSsh(["ssh", "-D", "1080", "host"]).kind).toBe("refused");
  });

  test("ssh -R port:host:port host → detail names port-forward", () => {
    expect(specSsh(["ssh", "-R", "8080:internal:80", "host"]).kind).toBe("refused");
  });

  test("zero positionals", () => {
    expect(specSsh(["ssh"]).kind).toBe("refused");
  });

  test("never returns complete or partial — fuzz with permutations", () => {
    const cases = [
      ["ssh", "host"],
      ["ssh", "-p", "22", "host"],
      ["ssh", "-A", "host"],
      ["ssh", "host", "ls"],
      ["ssh", "-i", "k", "host", "whoami"],
    ];
    for (const argv of cases) {
      const result = specSsh(argv);
      expect(result.kind).toBe("refused");
    }
  });

  test("wrong command name", () => {
    expect(specSsh(["scp", "host:src", "."]).kind).toBe("refused");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/ssh.test.ts`
Expected: cannot find module.

---

### Task 25: specSsh — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/ssh.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import type { SpecResult } from "./types.js";

const TRUST_BOUNDARY_PREFIXES = ["-o", "-F", "-J", "-D", "-L", "-R"] as const;

export function specSsh(argv: readonly string[]): SpecResult {
  if (argv[0] !== "ssh") {
    return { kind: "refused", cause: "parse-error", detail: "spec dispatched on non-ssh argv" };
  }

  const offending = findTrustBoundaryFlag(argv);
  if (offending !== null) {
    return {
      kind: "refused",
      cause: "unsupported-form",
      detail: `ssh ${offending} can rewrite endpoint, add port-forward surface, or trigger arbitrary local execution via ssh_config`,
    };
  }

  if (hasTrailingRemoteCommand(argv)) {
    return {
      kind: "refused",
      cause: "unsupported-form",
      detail: "ssh remote command requires exact-argv Run rule (argv prefix rules cannot safely authorize arbitrary remote payload)",
    };
  }

  return {
    kind: "refused",
    cause: "unsupported-form",
    detail: "plain ssh may invoke ProxyCommand/Include/IdentityFile via default ssh_config",
  };
}

function findTrustBoundaryFlag(argv: readonly string[]): string | null {
  for (const tok of argv.slice(1)) {
    for (const prefix of TRUST_BOUNDARY_PREFIXES) {
      if (tok === prefix) return prefix;
      if (tok.startsWith(prefix) && tok.length > prefix.length) return prefix;
    }
  }
  return null;
}

/**
 * Detects whether an ssh argv carries a trailing remote command.
 * Recognizes the bool/value flag set we accept (no trust-boundary
 * flags reach here — those return early). After consuming flags +
 * (optional `-l user`) + host positional, anything more is the remote
 * command.
 */
function hasTrailingRemoteCommand(argv: readonly string[]): boolean {
  let i = 1;
  let sawHost = false;
  const valueFlags = new Set(["p", "i", "l"]);
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (tok.startsWith("-") && tok.length > 1) {
      const name = tok[1];
      if (name !== undefined && valueFlags.has(name)) {
        // value-flag: skip its value (attached or separate)
        i = tok.length > 2 ? i + 1 : i + 2;
        continue;
      }
      // bool flag (recognized or not — we don't care here)
      i += 1;
      continue;
    }
    if (!sawHost) {
      sawHost = true;
      i += 1;
      continue;
    }
    return true;
  }
  return false;
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/ssh.test.ts`
Expected: 12 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/ssh.ts \
        packages/lib/bash-ast/src/specs/ssh.test.ts
git commit -m "feat(bash-ast): add specSsh — always refused; detail discriminates form (#1662)"
```

---

### Task 26: registry — failing tests

**Files:**
- Create: `packages/lib/bash-ast/src/specs/registry.test.ts`

Behaviour:
- `BUILTIN_SPECS.size === 10` and contains exactly the names `["rm","cp","mv","chmod","chown","curl","wget","tar","scp","ssh"]`.
- `BUILTIN_SPECS` is read-only (TS makes it ReadonlyMap; runtime-test by reading not writing).
- `createSpecRegistry()` returns a fresh mutable Map with all builtins.
- `registerSpec(reg, name, fn)` adds to the map; existing builtins remain.
- Two registries from `createSpecRegistry()` are independent (no shared state).

- [ ] **Step 1: Write the failing test file**

```typescript
import { describe, expect, test } from "bun:test";
import { BUILTIN_SPECS, createSpecRegistry, registerSpec } from "../registry.js";
import type { CommandSpec } from "../types.js";

const EXPECTED_BUILTINS: readonly string[] = [
  "rm",
  "cp",
  "mv",
  "chmod",
  "chown",
  "curl",
  "wget",
  "tar",
  "scp",
  "ssh",
];

describe("BUILTIN_SPECS", () => {
  test("contains exactly 10 entries", () => {
    expect(BUILTIN_SPECS.size).toBe(10);
  });

  test("contains exactly the expected command names", () => {
    expect([...BUILTIN_SPECS.keys()].sort()).toEqual([...EXPECTED_BUILTINS].sort());
  });

  test("each entry is callable and returns a SpecResult", () => {
    for (const [name, spec] of BUILTIN_SPECS) {
      const result = spec([name]);
      expect(["complete", "partial", "refused"]).toContain(result.kind);
    }
  });
});

describe("createSpecRegistry", () => {
  test("returns a Map seeded with all builtins", () => {
    const reg = createSpecRegistry();
    expect(reg.size).toBe(10);
    for (const name of EXPECTED_BUILTINS) {
      expect(reg.has(name)).toBe(true);
    }
  });

  test("returns a fresh mutable Map each call (no shared state)", () => {
    const a = createSpecRegistry();
    const b = createSpecRegistry();
    expect(a).not.toBe(b);
    a.set("custom", (() => ({ kind: "refused", cause: "parse-error", detail: "x" })) as CommandSpec);
    expect(a.has("custom")).toBe(true);
    expect(b.has("custom")).toBe(false);
  });
});

describe("registerSpec", () => {
  test("adds an entry to the given registry", () => {
    const reg = createSpecRegistry();
    const myFn: CommandSpec = () => ({ kind: "refused", cause: "parse-error", detail: "x" });
    registerSpec(reg, "git", myFn);
    expect(reg.get("git")).toBe(myFn);
    expect(reg.size).toBe(11);
  });

  test("preserves existing builtins after register", () => {
    const reg = createSpecRegistry();
    registerSpec(reg, "git", (() => ({ kind: "refused", cause: "parse-error", detail: "x" })) as CommandSpec);
    expect(reg.get("rm")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test packages/lib/bash-ast/src/specs/registry.test.ts`
Expected: cannot find module.

---

### Task 27: registry — implementation

**Files:**
- Create: `packages/lib/bash-ast/src/specs/registry.ts`

- [ ] **Step 1: Write the implementation**

```typescript
import { specChmod } from "./chmod.js";
import { specChown } from "./chown.js";
import { specCp } from "./cp.js";
import { specCurl } from "./curl.js";
import { specMv } from "./mv.js";
import { specRm } from "./rm.js";
import { specScp } from "./scp.js";
import { specSsh } from "./ssh.js";
import { specTar } from "./tar.js";
import { specWget } from "./wget.js";
import type { CommandSpec } from "./types.js";

/**
 * Read-only map of the ten builtin specs keyed by command name. Useful
 * for callers that only need lookup. Use `createSpecRegistry()` when
 * you need a mutable registry to register custom specs alongside.
 */
export const BUILTIN_SPECS: ReadonlyMap<string, CommandSpec> = new Map<string, CommandSpec>([
  ["rm", specRm],
  ["cp", specCp],
  ["mv", specMv],
  ["chmod", specChmod],
  ["chown", specChown],
  ["curl", specCurl],
  ["wget", specWget],
  ["tar", specTar],
  ["scp", specScp],
  ["ssh", specSsh],
]);

/**
 * Returns a fresh mutable `Map` seeded with all ten builtins. Each
 * caller gets an independent registry — there is no module-level
 * shared mutable state.
 */
export function createSpecRegistry(): Map<string, CommandSpec> {
  return new Map(BUILTIN_SPECS);
}

/**
 * Adds `fn` to `reg` under `name`. Thin wrapper over `Map.set` to
 * satisfy the issue's "registerSpec exposed from @koi/bash-ast" API
 * surface; consumers may equivalently call `reg.set(name, fn)`.
 */
export function registerSpec(
  reg: Map<string, CommandSpec>,
  name: string,
  fn: CommandSpec,
): void {
  reg.set(name, fn);
}
```

- [ ] **Step 2: Run the test, verify it passes**

Run: `bun test packages/lib/bash-ast/src/specs/registry.test.ts`
Expected: 7 tests pass.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/registry.ts \
        packages/lib/bash-ast/src/specs/registry.test.ts
git commit -m "feat(bash-ast): add BUILTIN_SPECS map + createSpecRegistry/registerSpec (#1662)"
```

---

### Task 28: specs barrel export

**Files:**
- Create: `packages/lib/bash-ast/src/specs/index.ts`

Re-exports the public surface of the specs subdirectory.

- [ ] **Step 1: Write the file**

```typescript
/**
 * @koi/bash-ast/specs — public re-export barrel.
 *
 * See `docs/L2/bash-ast.md` "Per-command semantics" section and
 * `docs/superpowers/specs/2026-04-18-bash-ast-command-specs-design.md`
 * for the full contract.
 */

export type {
  CommandSemantics,
  CommandSpec,
  NetworkAccess,
  SpecResult,
} from "./types.js";

export { BUILTIN_SPECS, createSpecRegistry, registerSpec } from "./registry.js";

export { specChmod } from "./chmod.js";
export { specChown } from "./chown.js";
export { specCp } from "./cp.js";
export { specCurl } from "./curl.js";
export { specMv } from "./mv.js";
export { specRm } from "./rm.js";
export { specScp } from "./scp.js";
export { specSsh } from "./ssh.js";
export { specTar } from "./tar.js";
export { specWget } from "./wget.js";
```

- [ ] **Step 2: Verify it typechecks**

Run: `bun run --cwd packages/lib/bash-ast typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/lib/bash-ast/src/specs/index.ts
git commit -m "feat(bash-ast): add specs barrel exporting types, registry, and ten specs (#1662)"
```

---

### Task 29: Wire specs into the package's public index

**Files:**
- Modify: `packages/lib/bash-ast/src/index.ts`

Existing file (per repo as of 2026-04-18) re-exports from `./analyze.js`, `./classify.js`, `./init.js`, `./matcher.js`, `./types.js`. Add a single re-export for the specs barrel.

- [ ] **Step 1: Read the current file to confirm exact shape**

Run: `cat packages/lib/bash-ast/src/index.ts`
Note the exact current export block to avoid breaking it.

- [ ] **Step 2: Append the specs re-export**

Edit the file to add (before the closing of the existing exports block):

```typescript
// Per-command semantic specs (see ./specs/index.ts and docs/L2/bash-ast.md).
export * from "./specs/index.js";
```

- [ ] **Step 3: Verify the package still builds and tests pass**

Run: `bun run --cwd packages/lib/bash-ast typecheck`
Expected: no errors.

Run: `bun test packages/lib/bash-ast/`
Expected: existing 271 tests still pass + new spec tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/lib/bash-ast/src/index.ts
git commit -m "feat(bash-ast): re-export specs from package public index (#1662)"
```

---

### Task 30: Update L2 documentation

**Files:**
- Modify: `docs/L2/bash-ast.md`

Append a new "## Per-command semantics" section after the existing public-API section. Content should cover: `SpecResult` discriminated union, the ten commands and their flag allowlists (table from spec doc), exact-argv `Run(...)` guard for partial/refused, link to the design spec, and an explicit note about the follow-up consumer issue.

- [ ] **Step 1: Read the current doc to find the right insertion point**

Run: `wc -l docs/L2/bash-ast.md`
Run: `grep -n "^## " docs/L2/bash-ast.md`
Pick the insertion point AFTER the existing public-API section, BEFORE any "## Tests" / "## Internals" section.

- [ ] **Step 2: Insert the new section**

Insert this content at the chosen point (preserve surrounding structure):

````markdown
## Per-command semantics

> See [`docs/superpowers/specs/2026-04-18-bash-ast-command-specs-design.md`](../superpowers/specs/2026-04-18-bash-ast-command-specs-design.md) for the full design + soundness contract.

The package exports per-command semantic specs that map a resolved
`argv: readonly string[]` (produced by the existing walker) to a
`SpecResult` discriminated union describing reads, writes, network
access, and env mutations. Covers ten commands: `rm`, `cp`, `mv`,
`chmod`, `chown`, `curl`, `wget`, `tar`, `scp`, `ssh`.

### Public API

```typescript
import {
  type CommandSemantics,
  type CommandSpec,
  type NetworkAccess,
  type SpecResult,
  BUILTIN_SPECS,
  createSpecRegistry,
  registerSpec,
  specRm, specCp, specMv, specChmod, specChown,
  specCurl, specWget, specTar, specScp, specSsh,
} from "@koi/bash-ast";
```

### `SpecResult` contract

| `kind` | Argv-aware rules (`Read`/`Write`/`Network`) | `Run(...)` rules |
|---|---|---|
| `complete` | use `semantics` freely | optional; prefix or exact, consumer's choice |
| `partial` | use `semantics` only paired with an exact-argv `Run(...)` co-rule | **must be exact-argv-match only** for this argv |
| `refused` | MUST NOT use; no semantics produced | **must be exact-argv-match only** for this argv |

`partial` carries `reason` (e.g., `"recursive-subtree-root"`,
`"cp-mv-dest-may-be-directory"`, `"wget-follows-redirects"`,
`"curl-follows-redirects"`, `"curl-O-derived-basename"`,
`"tar-extract-targets-in-archive"`).

`refused` carries `cause` (`"parse-error"` or `"unsupported-form"`)
and `detail` (free-form audit string).

### Universal exact-argv `Run(...)` guard

Bash rule matchers in this repo accept argv-prefix rules. A broad
allow like `Run(curl)` or `Run(ssh prod)` would otherwise re-authorize
forms the spec marked `partial` or `refused`, defeating their
fail-closed intent. **Consumers MUST reject or promote prefix-shaped
`Run(...)` rules whenever any argv they would match yields
`kind: "partial" | "refused"`.** This guard is consumer-side; the
spec cannot enforce it alone.

### Per-command flag allowlists

| Command | Recognized flags | Returns `kind: "refused"` on |
|---|---|---|
| `rm` | `-r`/`-R`, `-f`, `-i`, `-d`, `-v`, `--` | unknown flag, missing positional |
| `cp` | `-r`/`-R`, `-f`, `-i`, `-p`, `-a`, `-v`, `-t DIR`, `-T`, `--` | unknown flag, missing source/dest |
| `mv` | `-f`, `-i`, `-n`, `-v`, `-t DIR`, `-T`, `--` | unknown flag, missing source/dest |
| `chmod` | `-R`, `-v`, `-f`, `--` + mode + path | unknown flag, missing mode or path |
| `chown` | `-R`, `-v`, `-f`, `--` + owner + path | unknown flag, missing owner or path |
| `curl` | `-o`/`--output FILE`, `-O`, `-L`, `-X METHOD`, `-d`/`--data`, `-H`, `-s`, `-i`, URL(s) | `--config`/`-K`, `--next`, `-T`, unknown flag, unsupported URL scheme |
| `wget` | `-O FILE`, `-q`, `-c`, `-N`, URL(s) | `-i`/`--input-file`, unknown flag, non-http/ftp scheme |
| `tar` | `-x`/`-c`/`-t` (exactly one); `-f FILE`, `-z`/`-j`, `-C DIR`, `-v`, `--`, file list | conflicting mode flags, no `-f`, unknown flag |
| `scp` | n/a — always `refused` | every argv (default ssh_config exposure) |
| `ssh` | n/a — always `refused` | every argv (default ssh_config exposure) |

### This PR ships specs only

No package consumes the specs as of this commit. The follow-up
consumer issue MUST land all three of: (a) a consumer that calls
into specs, (b) the rule-evaluator change that promotes/rejects
prefix `Run(...)` rules whenever any matched argv yields
`kind: "partial" | "refused"`, (c) the golden query proving the
end-to-end deny path. Splitting (a) from (b) opens a fail-open
window. See the design doc for the full bundling rationale.

````

- [ ] **Step 3: Verify the doc renders**

Run: `wc -l docs/L2/bash-ast.md`
Inspect with `head -200 docs/L2/bash-ast.md` and the end with `tail -120 docs/L2/bash-ast.md`. Confirm no broken markdown.

- [ ] **Step 4: Commit**

```bash
git add docs/L2/bash-ast.md
git commit -m "docs(bash-ast): add per-command semantics section to L2 docs (#1662)"
```

---

### Task 31: Run the full CI gate

This task runs every check the CI pipeline enforces. Stop and fix anything that fails before moving on.

- [ ] **Step 1: Run typecheck on the package**

Run: `bun run --cwd packages/lib/bash-ast typecheck`
Expected: no errors.

- [ ] **Step 2: Run the full test suite for the package**

Run: `bun run test --filter=@koi/bash-ast`
Expected: all tests pass; coverage ≥ 80%.

- [ ] **Step 3: Run the lint**

Run: `bun run --cwd packages/lib/bash-ast lint`
Expected: no errors. Fix any Biome complaints before continuing.

- [ ] **Step 4: Run the layer check (repo-wide)**

Run: `bun run check:layers`
Expected: pass. `@koi/bash-ast` is L0u; the new files only import from `./*.js` siblings and don't pull in any other `@koi/*` package, so this should be a no-op.

- [ ] **Step 5: Run the unused-export check**

Run: `bun run check:unused`
Expected: pass. If a spec function is reported as unused, double-check that `specs/index.ts` re-exports it AND `src/index.ts` re-exports the barrel.

- [ ] **Step 6: Run the duplicates check**

Run: `bun run check:duplicates`
Expected: pass. cp.ts and mv.ts share basename-derivation patterns — already factored into `posix-basename.ts`. If duplicates fire on the cp/mv `if (typeof tValue === "string")` branches, extract a tiny helper into `parse-flags.ts` (e.g., `deriveBasenamesOrRefuse(srcs, dst)`).

- [ ] **Step 7: If any step failed, fix and re-run from Step 1**

If everything passes, no commit needed (CI checks don't change source).

---

### Task 32: Open the follow-up tracking issue

This is the consumer-PR tracker referenced from the design doc. It MUST mention the bundling requirement and the exact-argv guard.

- [ ] **Step 1: Confirm `gh` is authenticated for the right repo**

Run: `gh repo view --json nameWithOwner -q .nameWithOwner`
Expected: `windoliver/koi`. If not, fix auth before continuing.

- [ ] **Step 2: Create the issue**

Run:
```bash
gh issue create --title '@koi/security/middleware-permissions: consume bash-ast specs for write/read/network rules' --body "$(cat <<'EOF'
Follow-up to #1662, which shipped per-command semantic specs in `@koi/bash-ast` (exported but unconsumed).

## Mandatory bundling

This issue MUST land all three pieces in a single PR:

1. **Consumer wiring** — `@koi/security/middleware-permissions` (or a new shim) calls into `@koi/bash-ast/specs` (`createSpecRegistry`, `BUILTIN_SPECS`, or named `spec*` functions) to translate bash invocations into resource-aware permission queries.
2. **Exact-argv `Run(...)` enforcement** — `@koi/security/permissions` rule-evaluator gates prefix `Run(...)` rules against per-argv spec results. Any argv where the spec returns `kind: "partial" | "refused"` requires an exact-argv `Run(...)` rule; prefix-shaped rules are either promoted to exact match or rejected at config-load.
3. **Golden query** — wired into `@koi/runtime` (`packages/meta/runtime/src/__tests__/golden-replay.test.ts`) proving the end-to-end deny path (e.g., `Bash(rm -rf /etc)` → spec → permission deny → trajectory reflects deny).

Splitting (a) from (b) creates a fail-open window: operators would believe `partial`/`refused` are protective while existing prefix `Run(...)` rules continue to allow the underlying invocations. The PR description MUST link the design doc and call out the bundle.

## Scope

- Extend `@koi/security/permissions` rule schema with `Write(path)`, `Read(path)`, `Network(host)` shapes (see [design doc](https://github.com/windoliver/koi/blob/main/docs/superpowers/specs/2026-04-18-bash-ast-command-specs-design.md)).
- Update `packages/security/permissions/src/rule-evaluator.ts` to gate prefix `Run(...)` against per-argv spec results.
- Wire bash-aware decision path in `packages/security/middleware-permissions/src/middleware.ts` (currently 2398 lines — well past the 800 hard max; consider splitting into smaller files first).
- Use `NetworkAccess.host` (the structured field), NOT raw `target`, when evaluating `Network(host)` rules. Tests MUST prove `Network(example.com)` matches `curl https://example.com/path`.
- ssh/scp do NOT emit `NetworkAccess` (always refused); consumers must use exact-argv `Run(ssh ...)` / `Run(scp ...)` rules. A future PR that models default ssh_config can revisit.

## Critical consumer guard

For every argv where the spec returns `kind: "partial" | "refused"`, `Run(...)` rules MUST be exact-argv-only for that argv. Prefix-shaped rules either get promoted to exact match or rejected at config-load. Without this, broad allow-rules (`Run(curl)`, `Run(ssh prod)`, `Run(scp host)`) re-authorize the under-modeled or refused forms the spec deliberately marked non-authoritative (unknown URL schemes, ssh remote commands, ssh/scp trust-boundary flags, redirect-following HTTP, destination-may-be-directory cp/mv, etc.). The guard MUST have explicit consumer-side tests proving prefix `Run(...)` rules are rejected/promoted for these forms.

## References

- Spec / design doc: `docs/superpowers/specs/2026-04-18-bash-ast-command-specs-design.md`
- Specs PR: #1662
- Bash-ast L2 docs: `docs/L2/bash-ast.md` (Per-command semantics section)
EOF
)"
```

- [ ] **Step 3: Capture the new issue URL and add it to the spec doc + PR description later**

The command output prints the new issue URL (e.g., `https://github.com/windoliver/koi/issues/NNNN`). Save it for the PR description; no commit needed in this task.

---

### Task 33: Open the PR

Final step — open the PR for #1662 from this branch. Body links the design doc + the new follow-up issue.

- [ ] **Step 1: Push the branch**

Run: `git push -u origin feat/issue-1662-bash-specs`
Expected: branch pushed; PR-creation hint in output.

- [ ] **Step 2: Open the PR**

Replace `<follow-up-url>` with the URL captured in Task 32.

```bash
gh pr create --title "feat(bash-ast): per-command semantic specs (#1662)" --body "$(cat <<'EOF'
Closes #1662.

## Summary
- New `packages/lib/bash-ast/src/specs/` directory with ten per-command specs (`specRm`, `specCp`, `specMv`, `specChmod`, `specChown`, `specCurl`, `specWget`, `specTar`, `specScp`, `specSsh`).
- `SpecResult` discriminated union (`complete` / `partial` / `refused`) machine-signals the trust level of each result; consumer policy is documented in `docs/L2/bash-ast.md` and the design doc.
- `BUILTIN_SPECS: ReadonlyMap`, `createSpecRegistry()`, `registerSpec(reg, name, fn)` exposed from the package root.
- Specs are exported but **unconsumed** in this PR — security value depends on the follow-up consumer PR.

## Design + soundness contract
See `docs/superpowers/specs/2026-04-18-bash-ast-command-specs-design.md`. Highlights:
- ssh/scp always `refused` (default ssh_config can inject `ProxyCommand`/`Include`/`IdentityFile`/`Host` aliases without any flag on argv).
- curl/wget URL scheme dispatch via `URL` constructor; `file://` only with empty authority.
- cp/mv `-T` complete; `-t DIR` derives `DIR/<basename(src)>`; destination-last over-approximates writes (both possibilities) and marks `partial`.
- Recursive forms (`rm -r`, `cp -r`, `chmod -R`, `chown -R`) are `partial` with `reason: "recursive-subtree-root"`; consumer rule treats subtree root as covering descendants.

## Follow-up
<follow-up-url> tracks the consumer + golden-query PR. **That PR must bundle (a) consumer wiring, (b) exact-argv `Run(...)` enforcement, (c) golden query** — splitting them creates a fail-open window.

## Test plan
- [x] `bun run test --filter=@koi/bash-ast` (existing 271 + new spec tests)
- [x] `bun run --cwd packages/lib/bash-ast typecheck`
- [x] `bun run --cwd packages/lib/bash-ast lint`
- [x] `bun run check:layers`
- [x] `bun run check:unused`
- [x] `bun run check:duplicates`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 3: Capture the PR URL**

Output prints the new PR URL — share it back to the user; no further commits needed.

---

## Self-review checklist (run before declaring the plan done)

- [ ] **Spec coverage**: every line of the design doc's "Per-command semantics" section maps to a Task above. Acceptance checklist items in the design map to Tasks 6–25 (specs), 26–28 (registry + exports), 29 (wiring), 30 (docs), 31 (CI), 32 (follow-up issue).
- [ ] **No placeholders**: no "TBD", "implement later", or vague test stubs anywhere above. Every test file is complete code; every implementation is complete code.
- [ ] **Type consistency**: `SpecResult`, `CommandSemantics`, `NetworkAccess`, `CommandSpec`, `BasenameResult`, `FlagAllowlist`, `ParseFlagsResult` are defined exactly once and referenced consistently. Spec function names match `spec<Cmd>` everywhere.
- [ ] **Per-command file size**: each spec file is < 80 lines (acceptance criterion). cp.ts and mv.ts are the longest (~75 lines each); curl.ts is ~85 lines including the `dispatchUrl` helper — if it tips over 80, extract `dispatchUrl` to its own file `curl-url.ts`.
- [ ] **No new dependencies**: every import is a sibling `./*.js` file or a TS lib type. No new entries in `package.json`.
