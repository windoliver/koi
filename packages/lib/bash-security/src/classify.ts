import { classifyCommand } from "./bash-classifier.js";
import { detectInjection } from "./injection-detector.js";
import { validatePath } from "./path-validator.js";
import type { BashPolicy, ClassificationResult } from "./types.js";

/**
 * Run the full security classification pipeline against a bash command.
 *
 * Pipeline order (fastest-first to maximize early-exit on blocked commands):
 * 1. Allowlist check (if configured) — O(prefixes * command.length)
 * 2. Injection detection — cheapest pattern set
 * 3. Path validation (if cwd provided) — realpath + pattern set
 * 4. Command classification — largest pattern set
 *
 * The denylist (steps 2–4) always runs, even for commands that pass the
 * allowlist. This enforces defense-in-depth: an allowlisted prefix does not
 * grant immunity from known dangerous TTP patterns.
 */
export function classifyBashCommand(
  command: string,
  opts?: {
    readonly cwd?: string;
    readonly policy?: BashPolicy;
    readonly workspaceRoot?: string;
  },
): ClassificationResult {
  const { cwd, policy, workspaceRoot } = opts ?? {};

  // 1. Allowlist gate — if configured, command must match at least one prefix.
  //    When an allowlist is active we also reject compound-command operators
  //    (;  &&  ||  |  \n  `  $() ) so that an attacker cannot chain an allowed
  //    prefix with an arbitrary follow-on command:  `git status; rm -rf /tmp`
  if (policy?.allowlist !== undefined && policy.allowlist.length > 0) {
    const allowlisted = policy.allowlist.some((prefix) => command.startsWith(prefix));
    if (!allowlisted) {
      return {
        ok: false,
        reason: "Command does not match any configured allowlist prefix",
        pattern: policy.allowlist.join(" | "),
        category: "injection",
      };
    }
    // Compound operators would let the attacker append arbitrary code after the
    // allowed prefix.  Reject them so the allowlist is a meaningful boundary.
    const compoundMatch = /[;|&`\n]|\$\(/.exec(command);
    if (compoundMatch !== null) {
      return {
        ok: false,
        reason:
          "Compound command operators are disallowed when an allowlist is active — use a single simple command",
        pattern: compoundMatch[0],
        category: "injection",
      };
    }
  }

  // 2. Injection detection — fastest
  const injection = detectInjection(command);
  if (!injection.ok) return injection;

  // 3. Path validation — validates cwd against workspaceRoot.
  //    Note: file/path arguments embedded in the command string are NOT validated
  //    here — that would require shell parsing.  Callers must either use an
  //    OS-level sandbox (wrapCommand) or restrict commands via the allowlist.
  if (cwd !== undefined) {
    const pathResult = validatePath(cwd, workspaceRoot);
    if (!pathResult.ok) return pathResult;
  }

  // 4. Command classification — most patterns
  return classifyCommand(command);
}
