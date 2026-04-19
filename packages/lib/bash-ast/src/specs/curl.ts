import { type FlagAllowlist, parseFlags } from "./parse-flags.js";
import type { CommandSemantics, NetworkAccess, SpecResult } from "./types.js";

const CURL_ALLOW = {
  bool: new Set(["O", "L", "s", "i"]),
  value: new Set(["o", "output", "X", "d", "data", "H"]),
} as const satisfies FlagAllowlist;

export function specCurl(argv: readonly string[]): SpecResult {
  if (argv[0] !== "curl") {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specCurl dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected "curl"`,
    };
  }

  for (const tok of argv.slice(1)) {
    if (
      tok === "--config" ||
      tok.startsWith("--config=") ||
      tok === "-K" ||
      tok.startsWith("-K") ||
      tok === "--next"
    ) {
      return {
        kind: "refused",
        cause: "unsupported-form",
        detail: `curl flag ${tok} can rewrite request behavior; refused`,
      };
    }
    if (
      tok === "-T" ||
      tok.startsWith("-T") ||
      tok === "--upload-file" ||
      tok.startsWith("--upload-file=")
    ) {
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

  for (const url of parsed.positionals) {
    const dispatched = dispatchUrl(url);
    if (dispatched.kind === "refused") return dispatched;
    if (dispatched.network) network.push(dispatched.network);
    if (dispatched.read !== undefined) reads.push(dispatched.read);
  }

  // -o / --output and -d / --data may appear multiple times; collapsing to
  // parsed.flags.get(...) would under-report writes/reads. Scan argv directly
  // to capture every occurrence.
  for (const outValue of collectRepeatedFlag(argv, "o", "output")) {
    writes.push(outValue);
  }
  for (const dataValue of collectRepeatedFlag(argv, "d", "data")) {
    if (dataValue.startsWith("@")) reads.push(dataValue.slice(1));
  }

  const reasons: string[] = [];
  if (parsed.flags.has("L")) reasons.push("curl-follows-redirects");
  if (parsed.flags.has("O")) reasons.push("curl-O-derived-basename");

  const semantics: CommandSemantics = { reads, writes, network, envMutations: [] };

  if (reasons.length > 0) {
    return { kind: "partial", semantics, reason: reasons.join(";") };
  }
  return { kind: "complete", semantics };
}

/**
 * Walk argv and collect every value passed to a value-taking flag whose
 * short form is `-<short>` (e.g. `-d`) and long form is `--<long>` (e.g.
 * `--data`). Recognises all standard forms:
 *   `-<short> VALUE` (separate)
 *   `-<short>VALUE`  (attached short, no space)
 *   `--<long> VALUE` (separate long)
 *   `--<long>=VALUE` (long with equals)
 */
function collectRepeatedFlag(
  argv: readonly string[],
  short: string,
  long: string,
): readonly string[] {
  const out: string[] = [];
  const shortPrefix = `-${short}`;
  const longExact = `--${long}`;
  const longEq = `--${long}=`;
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok === shortPrefix || tok === longExact) {
      const next = argv[i + 1];
      if (next !== undefined) {
        out.push(next);
        i += 1;
      }
      continue;
    }
    if (tok.startsWith(shortPrefix) && tok.length > shortPrefix.length && !tok.startsWith("--")) {
      out.push(tok.slice(shortPrefix.length));
      continue;
    }
    if (tok.startsWith(longEq)) {
      out.push(tok.slice(longEq.length));
    }
  }
  return out;
}

interface UrlDispatchOk {
  readonly kind: "ok";
  readonly network?: NetworkAccess;
  readonly read?: string;
}

type UrlDispatch =
  | UrlDispatchOk
  | {
      readonly kind: "refused";
      readonly cause: "parse-error" | "unsupported-form";
      readonly detail: string;
    };

function dispatchUrl(raw: string): UrlDispatch {
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
        detail: `${url.protocol} crosses SSH trust boundary; same default ssh_config exposure as ssh/scp commands`,
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
