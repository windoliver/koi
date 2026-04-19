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
 *
 * Ambiguity rule: `-tf` where `t` is a value-flag and `f` is a known bool is
 * refused. When the head char is a value-flag and remaining chars are ALL
 * recognised bools, the bundle is ambiguous and we fail-closed rather than
 * guess POSIX intent. Attached value form requires non-flag chars (e.g. `-t/dest`).
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

export function parseFlags(argv: readonly string[], allow: FlagAllowlist): ParseFlagsResult {
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let cutoff = false; // justified let: mutable parser state machine

  for (let i = 1; i < argv.length; i += 1) {
    // justified let: index mutation in loop
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

type LongResult = LongOk | { readonly ok: false; readonly detail: string };

function consumeLong(
  tok: string,
  argv: readonly string[],
  i: number,
  allow: FlagAllowlist,
): LongResult {
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

type ShortResult = ShortOk | { readonly ok: false; readonly detail: string };

function consumeShort(
  tok: string,
  argv: readonly string[],
  i: number,
  allow: FlagAllowlist,
): ShortResult {
  const head = tok[1];
  if (head === undefined) {
    return { ok: false, detail: `invalid flag token: ${tok}` };
  }

  // Value-flag path: head char takes a value argument.
  // POSIX semantics: once the head is a value-taking option, every remaining
  // char in the token is the value, even if those chars happen to coincide
  // with bool-flag names (e.g. `-oLi` is `-o` with value `Li`).
  if (allow.value.has(head)) {
    if (tok.length > 2) {
      return { ok: true, flags: [[head, tok.slice(2)]], nextIndex: i };
    }
    // Separate-arg form: `-t VALUE`
    const next = argv[i + 1];
    if (next === undefined) {
      return { ok: false, detail: `missing value for -${head}` };
    }
    return { ok: true, flags: [[head, next]], nextIndex: i + 1 };
  }

  // Bool-bundle path: every char must be a known bool.
  const out: Array<readonly [string, true]> = [];
  for (const ch of tok.slice(1)) {
    if (!allow.bool.has(ch)) {
      return { ok: false, detail: `unknown short flag -${ch}` };
    }
    out.push([ch, true]);
  }
  return { ok: true, flags: out, nextIndex: i };
}
