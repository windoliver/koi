import { matchesCommand } from "./dispatch-name.js";
import { type FlagAllowlist, parseFlags } from "./parse-flags.js";
import type { CommandSemantics, NetworkAccess, SpecResult } from "./types.js";

// `i` and `input-file` are listed in the value allowlist so parseFlags
// consumes their values correctly (preventing other flags' values that
// happen to look like `-i...` from being misread). Their presence in
// `parsed.flags` after parsing triggers a post-parse `unsupported-form`
// refusal.
const WGET_ALLOW = {
  bool: new Set(["q", "c", "N"]),
  value: new Set(["O", "i", "input-file"]),
} as const satisfies FlagAllowlist;

const REFUSED_FLAGS: ReadonlyMap<string, string> = new Map([
  ["i", "-i"],
  ["input-file", "--input-file"],
]);

export function specWget(argv: readonly string[]): SpecResult {
  if (!matchesCommand("wget", argv)) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specWget dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected basename "wget"`,
    };
  }

  const parsed = parseFlags(argv, WGET_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  for (const [name, label] of REFUSED_FLAGS) {
    if (parsed.flags.has(name)) {
      return {
        kind: "refused",
        cause: "unsupported-form",
        detail: `wget ${label} reads URLs from a file; refused`,
      };
    }
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
  // `-O -` writes to stdout, not a file named "-". Drop the sentinel.
  if (typeof outFile === "string" && outFile !== "-") writes.push(outFile);

  const semantics: CommandSemantics = { reads: [], writes, network, envMutations: [] };
  return { kind: "partial", semantics, reason: "wget-follows-redirects" };
}
