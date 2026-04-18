/**
 * DANGEROUS_PATTERNS — structural TTP registry shipped as frozen data.
 *
 * Structural means: matches on command shape (binary + flag + operator
 * structure), not on specific URLs, hostnames, or file paths. Target
 * reputation and path safety belong in sibling packages
 * (`url-safety`, `@koi/bash-security`).
 *
 * Patterns are stateless (no `g`/`y` flags) so concurrent `test()` calls
 * cannot interfere through `RegExp.prototype.lastIndex`.
 */

import type { DangerousPattern } from "./types.js";

// System-path alternation used by rm -rf / chmod -R 777 patterns. Matches
// either a bare `/` (end-of-string, whitespace, or wildcard), a top-level
// system directory, or the literal home indicator.
const SYSTEM_TARGET =
  "(?:\\/(?:$|\\s|\\*|etc\\b|usr\\b|bin\\b|boot\\b|dev\\b|lib(?:32|64)?\\b|sbin\\b|var\\b|opt\\b|root\\b|srv\\b|home\\b)|~(?:$|\\s)|\\$HOME\\b)";

const PROCESS_SPAWN: readonly DangerousPattern[] = [
  {
    id: "fork-bomb",
    regex: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    category: "process-spawn",
    severity: "critical",
    message: "Fork bomb exhausts process slots and wedges the host",
  },
];

const FILE_DESTRUCTIVE: readonly DangerousPattern[] = [
  {
    id: "rm-rf-system",
    regex: new RegExp(
      `\\brm\\b[^\\n#]*\\s(?:--recursive\\s+--force|--force\\s+--recursive|-[a-zA-Z]*(?:[rR][a-zA-Z]*[fF]|[fF][a-zA-Z]*[rR])[a-zA-Z]*)[^\\n#]*?\\s${SYSTEM_TARGET}`,
    ),
    category: "file-destructive",
    severity: "critical",
    message: "rm -rf targeting root, a system directory, or $HOME is unrecoverable",
  },
  {
    id: "dd-to-device",
    regex: /\bdd\b[^\n#]*\bof=\/dev\//,
    category: "file-destructive",
    severity: "critical",
    message: "dd writing to a /dev/ block device destroys all data on the target disk",
  },
  {
    id: "mkfs",
    regex: /\b(?:mkfs(?:\.\w+)?|mke2fs|mkswap)\b/,
    category: "file-destructive",
    severity: "critical",
    message: "mkfs/mkswap formats a filesystem and destroys all data on the device",
  },
  {
    id: "shred",
    regex: /\bshred\b[^#\n]*-[a-zA-Z]*[un]/,
    category: "file-destructive",
    severity: "high",
    message: "shred -u/-n overwrites and deletes files irrecoverably",
  },
];

const NETWORK_EXFIL: readonly DangerousPattern[] = [
  {
    id: "curl-pipe-shell",
    regex: /\bcurl\b[^|#\n]*\|\s*(?:ba|z)?sh\b/,
    category: "network-exfil",
    severity: "high",
    message: "curl-pipe-shell executes remotely fetched code",
  },
  {
    id: "wget-pipe-shell",
    regex: /\bwget\b[^|#\n]*\|\s*(?:ba|z)?sh\b/,
    category: "network-exfil",
    severity: "high",
    message: "wget-pipe-shell executes remotely fetched code",
  },
  {
    id: "netcat-listen-exec",
    regex: /\b(?:ncat|nc)\b[^#\n]*-[a-zA-Z]*[le]/,
    category: "network-exfil",
    severity: "high",
    message: "netcat with listen or exec flags is a reverse-shell vector",
  },
];

const CODE_EXEC: readonly DangerousPattern[] = [
  {
    id: "curl-pipe-shell-exec",
    regex: /\bcurl\b[^|#\n]*\|\s*(?:ba|z)?sh\b/,
    category: "code-exec",
    severity: "high",
    message: "Piping curl output to a shell interpreter executes downloaded code",
  },
  {
    id: "eval",
    regex: /\beval\b/,
    category: "code-exec",
    severity: "high",
    message: "eval executes arbitrary strings as shell commands",
  },
  {
    id: "shell-dash-c",
    regex: /\b(?:ba|z)?sh\b\s+-c\b/,
    category: "code-exec",
    severity: "medium",
    message: "sh/bash/zsh -c executes an arbitrary command string",
  },
  {
    id: "powershell-invoke-expression",
    regex: /\bInvoke-Expression\b/,
    category: "code-exec",
    severity: "high",
    message: "PowerShell Invoke-Expression executes arbitrary strings as commands",
  },
  {
    id: "powershell-iex",
    regex: /\bIEX\b/,
    category: "code-exec",
    severity: "high",
    message: "PowerShell IEX is the Invoke-Expression alias",
  },
];

const MODULE_LOAD: readonly DangerousPattern[] = [
  {
    id: "python-dunder-import",
    regex: /\bpython[23]?\b[^#\n]*-c\b[^#\n]*__import__/,
    category: "module-load",
    severity: "high",
    message: "python -c with __import__ loads modules dynamically for arbitrary code execution",
  },
  {
    id: "node-require-exec",
    regex: /\bnode\b[^#\n]*-e\b[^#\n]*\brequire\s*\(/,
    category: "module-load",
    severity: "high",
    message: "node -e with require() loads modules for arbitrary code execution",
  },
  {
    id: "perl-e",
    regex: /\bperl\b\s+-[eE]\b/,
    category: "module-load",
    severity: "high",
    message: "perl -e executes an arbitrary script string",
  },
  {
    id: "ruby-e",
    regex: /\bruby\b\s+-[eE]\b/,
    category: "module-load",
    severity: "high",
    message: "ruby -e executes an arbitrary script string",
  },
];

const PRIVILEGE_ESCALATION: readonly DangerousPattern[] = [
  {
    id: "sudo",
    regex: /\bsudo\b/,
    category: "privilege-escalation",
    severity: "medium",
    message: "sudo executes commands with elevated privileges",
  },
  {
    id: "su",
    regex: /\bsu\s+(?:-|\w)/,
    category: "privilege-escalation",
    severity: "medium",
    message: "su switches to another user account",
  },
  {
    id: "chmod-setuid",
    regex: /\bchmod\b[^#\n]*(?:\+[a-rt-z]*s|\b[2-7][0-7]{3}\b)/,
    category: "privilege-escalation",
    severity: "high",
    message: "chmod with setuid/setgid bit enables privilege escalation",
  },
  {
    id: "chmod-777-system",
    regex: new RegExp(
      `\\bchmod\\b[^\\n#]*\\s-[a-zA-Z]*R[a-zA-Z]*\\s+[0-7]*777[0-7]*\\s+${SYSTEM_TARGET}`,
    ),
    category: "privilege-escalation",
    severity: "high",
    message: "chmod -R 777 on root or a system directory is a catastrophic permission change",
  },
  {
    id: "chown-root",
    regex: /\bchown\b[^#\n]*\b(?:root\b|0:0)/,
    category: "privilege-escalation",
    severity: "medium",
    message: "chown root reassigns ownership to the root user",
  },
];

/** All structural danger patterns. Ordered by severity (critical first). */
export const DANGEROUS_PATTERNS: readonly DangerousPattern[] = Object.freeze([
  ...PROCESS_SPAWN,
  ...FILE_DESTRUCTIVE,
  ...NETWORK_EXFIL,
  ...CODE_EXEC,
  ...MODULE_LOAD,
  ...PRIVILEGE_ESCALATION,
]);
