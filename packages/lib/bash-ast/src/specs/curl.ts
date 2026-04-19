import { matchesCommand } from "./dispatch-name.js";
import { type FlagAllowlist, parseFlags } from "./parse-flags.js";
import type { CommandSemantics, NetworkAccess, SpecResult } from "./types.js";

// Refused-by-design value flags are listed in the allowlist so parseFlags
// consumes their value tokens correctly (preventing other flags' values that
// happen to start with `-K`/`-T` from being misread). Their presence in
// `parsed.flags` after parseFlags triggers a post-parse `unsupported-form`
// refusal.
const CURL_ALLOW = {
  bool: new Set(["O", "L", "s", "i", "next"]),
  value: new Set(["o", "output", "X", "d", "data", "H", "K", "config", "T", "upload-file"]),
} as const satisfies FlagAllowlist;

const REFUSED_FLAGS: ReadonlyMap<string, { readonly label: string; readonly reason: string }> =
  new Map([
    ["K", { label: "-K", reason: "rewrite request behavior" }],
    ["config", { label: "--config", reason: "rewrite request behavior" }],
    ["next", { label: "--next", reason: "rewrite request behavior" }],
    ["T", { label: "-T", reason: "uploads local files; model with explicit reads" }],
    [
      "upload-file",
      { label: "--upload-file", reason: "uploads local files; model with explicit reads" },
    ],
  ]);

export function specCurl(argv: readonly string[]): SpecResult {
  if (!matchesCommand("curl", argv)) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specCurl dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected basename "curl"`,
    };
  }

  const parsed = parseFlags(argv, CURL_ALLOW);
  if (!parsed.ok) {
    return { kind: "refused", cause: "parse-error", detail: parsed.detail };
  }

  for (const [name, meta] of REFUSED_FLAGS) {
    if (parsed.flags.has(name)) {
      return {
        kind: "refused",
        cause: "unsupported-form",
        detail: `curl flag ${meta.label} can ${meta.reason}; refused`,
      };
    }
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

  // -o / --output and -d / --data may appear multiple times; the regular
  // parsed.flags.get(...) only retains the LAST occurrence and would
  // under-report writes/reads. Use valueOccurrences (collected during the
  // real parse) so values that belong to other flags are not misread.
  for (const outValue of [
    ...(parsed.valueOccurrences.get("o") ?? []),
    ...(parsed.valueOccurrences.get("output") ?? []),
  ]) {
    writes.push(outValue);
  }
  for (const dataValue of [
    ...(parsed.valueOccurrences.get("d") ?? []),
    ...(parsed.valueOccurrences.get("data") ?? []),
  ]) {
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
