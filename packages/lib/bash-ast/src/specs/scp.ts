import { matchesCommand } from "./dispatch-name.js";
import type { SpecResult } from "./types.js";

const TRUST_BOUNDARY_PREFIXES = ["-o", "-F", "-J"] as const;

export function specScp(argv: readonly string[]): SpecResult {
  if (!matchesCommand("scp", argv)) {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specScp dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected basename "scp"`,
    };
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
