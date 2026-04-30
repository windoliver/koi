/**
 * Minimal glob → RegExp compiler for capability-attenuation allowlists.
 *
 * Supports the subset of glob semantics needed for path / credential-key
 * scoping. Avoids the full minimatch surface (no brace expansion, no
 * negation, no extglob) to keep the matcher trivial to audit.
 *
 * Wildcards:
 *   `**`  matches any number of path segments (including zero).
 *   `*`   matches zero or more characters within a single segment.
 *   `?`   matches exactly one non-separator character.
 *
 * All other regex-significant characters are escaped. Matching is
 * case-sensitive; the path separator is `/` (callers normalize before
 * matching).
 */

const REGEX_SPECIALS = /[.+^${}()|[\]\\]/g;

export function compileGlob(pattern: string): RegExp {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];

    if (ch === "*") {
      // Detect `**` (optionally followed by `/`).
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          // `**/` — zero or more leading segments.
          out += "(?:.*/)?";
          i += 3;
          continue;
        }
        // `**` — match anything, including separators.
        out += ".*";
        i += 2;
        continue;
      }
      // Single `*` — match within a segment.
      out += "[^/]*";
      i += 1;
      continue;
    }

    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }

    out += (ch ?? "").replace(REGEX_SPECIALS, "\\$&");
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

export function compileGlobs(patterns: readonly string[]): readonly RegExp[] {
  return patterns.map(compileGlob);
}

export function matchAny(value: string, regexes: readonly RegExp[]): boolean {
  for (const re of regexes) {
    if (re.test(value)) return true;
  }
  return false;
}
