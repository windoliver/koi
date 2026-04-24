import type { FlagAllowlist } from "../specs/parse-flags.js";

export interface PrefixResult {
  readonly ok: true;
  readonly flags: ReadonlyMap<string, string | true>;
  /** Index into original argv[] of the first positional (inner CMD or DURATION). */
  readonly firstPositionalIndex: number;
}

type ParseResult = PrefixResult | { readonly ok: false; readonly detail: string };

/**
 * Parses wrapper flags from `argv[1..]`, stopping at the first positional
 * argument or `--`. Unlike `parseFlags`, does NOT continue past positionals,
 * preventing inner-command flags from being misread as wrapper flags.
 */
export function parseWrapperPrefix(argv: readonly string[], allow: FlagAllowlist): ParseResult {
  const flags = new Map<string, string | true>();
  let i = 1;

  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;

    if (tok === "--") {
      i += 1;
      break;
    }

    if (!tok.startsWith("-") || tok === "-") break; // first positional

    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      if (allow.bool.has(name)) {
        if (eq !== -1)
          return { ok: false, detail: `boolean flag --${name} does not accept a value` };
        flags.set(name, true);
        i += 1;
        continue;
      }
      if (allow.value.has(name)) {
        if (eq !== -1) {
          flags.set(name, body.slice(eq + 1));
          i += 1;
          continue;
        }
        const next = argv[i + 1];
        if (next === undefined) return { ok: false, detail: `missing value for --${name}` };
        flags.set(name, next);
        i += 2;
        continue;
      }
      return { ok: false, detail: `unknown long flag --${name}` };
    }

    // short flag
    const head = tok[1];
    if (head === undefined) break;
    if (allow.value.has(head)) {
      if (tok.length > 2) {
        flags.set(head, tok.slice(2));
        i += 1;
        continue;
      }
      const next = argv[i + 1];
      if (next === undefined) return { ok: false, detail: `missing value for -${head}` };
      flags.set(head, next);
      i += 2;
      continue;
    }
    // bool bundle: every char must be known
    for (const ch of tok.slice(1)) {
      if (!allow.bool.has(ch)) return { ok: false, detail: `unknown short flag -${ch}` };
      flags.set(ch, true);
    }
    i += 1;
  }

  return { ok: true, flags, firstPositionalIndex: i };
}
