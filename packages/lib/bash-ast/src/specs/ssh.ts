import type { SpecResult } from "./types.js";

const TRUST_BOUNDARY_PREFIXES = ["-o", "-F", "-J", "-D", "-L", "-R"] as const;

export function specSsh(argv: readonly string[]): SpecResult {
  if (argv[0] !== "ssh") {
    return {
      kind: "refused",
      cause: "parse-error",
      detail: `specSsh dispatched on argv[0]="${argv[0] ?? "<empty>"}", expected "ssh"`,
    };
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
      detail:
        "ssh remote command requires exact-argv Run rule (argv prefix rules cannot safely authorize arbitrary remote payload)",
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
      if (tok === prefix || (tok.startsWith(prefix) && tok.length > prefix.length)) {
        return prefix;
      }
    }
  }
  return null;
}

function hasTrailingRemoteCommand(argv: readonly string[]): boolean {
  const valueFlags = new Set(["p", "i", "l"]);
  let i = 1;
  let sawHost = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (tok.startsWith("-") && tok.length > 1) {
      const name = tok[1];
      if (name !== undefined && valueFlags.has(name)) {
        i = tok.length > 2 ? i + 1 : i + 2;
        continue;
      }
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
