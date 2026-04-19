import { type FlagAllowlist, parseFlags } from "./parse-flags.js";
import type { CommandSemantics, NetworkAccess, SpecResult } from "./types.js";

const WGET_ALLOW = {
  bool: new Set(["q", "c", "N"]),
  value: new Set(["O"]),
} as const satisfies FlagAllowlist;

export function specWget(argv: readonly string[]): SpecResult {
  if (argv[0] !== "wget") {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specWget dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected "wget"`,
    };
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
