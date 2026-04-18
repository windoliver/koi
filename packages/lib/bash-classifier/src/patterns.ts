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
 *
 * Most patterns carry `commandPrefixes` so classifyCommand only fires
 * the regex when the command's first-token basename is in the list.
 * This prevents false positives where the dangerous keyword appears
 * inside a quoted argument (`echo "sudo"`, `git commit -m "bash -c"`).
 * Structural shapes (fork bomb, `curl | sh`) have no prefix set and
 * match on raw string only.
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
    commandPrefixes: ["rm"],
  },
  {
    id: "dd-to-device",
    regex: /\bdd\b[^\n#]*\bof=\/dev\//,
    category: "file-destructive",
    severity: "critical",
    message: "dd writing to a /dev/ block device destroys all data on the target disk",
    commandPrefixes: ["dd"],
  },
  {
    id: "mkfs",
    regex: /\b(?:mkfs(?:\.\w+)?|mke2fs|mkswap)\b/,
    category: "file-destructive",
    severity: "critical",
    message: "mkfs/mkswap formats a filesystem and destroys all data on the device",
    commandPrefixes: ["mkfs", "mke2fs", "mkswap"],
  },
  {
    id: "shred",
    regex: /\bshred\b[^#\n]*-[a-zA-Z]*[un]/,
    category: "file-destructive",
    severity: "high",
    message: "shred -u/-n overwrites and deletes files irrecoverably",
    commandPrefixes: ["shred"],
  },
];

const NETWORK_EXFIL: readonly DangerousPattern[] = [
  {
    // Pipe-to-shell: curl to any shell interpreter on the right side,
    // possibly behind a wrapper (env / sudo / command / exec / nohup)
    // and/or path-qualified (/bin/sh, /usr/bin/bash).
    id: "curl-pipe-shell",
    regex:
      /\bcurl\b[^|#\n]*\|\s*(?:(?:\/[^\s|&;]*\/)?(?:env|sudo|command|exec|nohup)\s+)?(?:\/[^\s|&;]*\/)?(?:ba|z|da|a)?sh\b/,
    category: "network-exfil",
    severity: "high",
    message: "curl-pipe-shell executes remotely fetched code",
  },
  {
    id: "wget-pipe-shell",
    regex:
      /\bwget\b[^|#\n]*\|\s*(?:(?:\/[^\s|&;]*\/)?(?:env|sudo|command|exec|nohup)\s+)?(?:\/[^\s|&;]*\/)?(?:ba|z|da|a)?sh\b/,
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
    commandPrefixes: ["nc", "ncat"],
  },
];

const CODE_EXEC: readonly DangerousPattern[] = [
  {
    // Same pipeline shape as curl-pipe-shell but with the code-exec
    // category. No commandPrefixes — structural.
    id: "curl-pipe-shell-exec",
    regex:
      /\bcurl\b[^|#\n]*\|\s*(?:(?:\/[^\s|&;]*\/)?(?:env|sudo|command|exec|nohup)\s+)?(?:\/[^\s|&;]*\/)?(?:ba|z|da|a)?sh\b/,
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
    commandPrefixes: ["eval"],
  },
  {
    id: "shell-dash-c",
    regex: /\b(?:ba|z|da|a)?sh\b\s+-[a-zA-Z]*c\b/,
    category: "code-exec",
    severity: "medium",
    message: "sh/bash/zsh/dash/ash -c executes an arbitrary command string",
    commandPrefixes: ["sh", "bash", "zsh", "dash", "ash"],
  },
  {
    id: "powershell-invoke-expression",
    regex: /\bInvoke-Expression\b/,
    category: "code-exec",
    severity: "high",
    message: "PowerShell Invoke-Expression executes arbitrary strings as commands",
    commandPrefixes: ["powershell", "pwsh"],
  },
  {
    id: "powershell-iex",
    regex: /\bIEX\b/,
    category: "code-exec",
    severity: "high",
    message: "PowerShell IEX is the Invoke-Expression alias",
    commandPrefixes: ["powershell", "pwsh"],
  },
];

const MODULE_LOAD: readonly DangerousPattern[] = [
  {
    // python -c / -cm inline string execution.
    id: "python-dash-c",
    regex: /\bpython[23]?\b[^#\n]*\s-[a-zA-Z]*c\b/,
    category: "module-load",
    severity: "high",
    message: "python -c evaluates an arbitrary script string",
    commandPrefixes: ["python", "python2", "python3"],
  },
  {
    // node / deno / bun -e | --eval / --print inline string execution.
    id: "node-dash-e",
    regex: /\b(?:node|deno|bun)\b[^#\n]*\s(?:-e|--eval|--print|-p)\b/,
    category: "module-load",
    severity: "high",
    message: "node/deno/bun inline-eval flag evaluates an arbitrary script string",
    commandPrefixes: ["node", "deno", "bun"],
  },
  {
    id: "perl-e",
    regex: /\bperl\b[^#\n]*\s-[eE]\b/,
    category: "module-load",
    severity: "high",
    message: "perl -e/-E executes an arbitrary script string",
    commandPrefixes: ["perl"],
  },
  {
    id: "ruby-e",
    regex: /\bruby\b[^#\n]*\s-[eE]\b/,
    category: "module-load",
    severity: "high",
    message: "ruby -e/-E executes an arbitrary script string",
    commandPrefixes: ["ruby"],
  },
  {
    id: "php-r",
    regex: /\bphp\b[^#\n]*\s(?:-r|--run)\b/,
    category: "module-load",
    severity: "high",
    message: "php -r evaluates an arbitrary PHP string",
    commandPrefixes: ["php"],
  },
  {
    id: "osascript-e",
    regex: /\bosascript\b[^#\n]*\s-e\b/,
    category: "module-load",
    severity: "high",
    message: "osascript -e evaluates an arbitrary AppleScript",
    commandPrefixes: ["osascript"],
  },
];

const PRIVILEGE_ESCALATION: readonly DangerousPattern[] = [
  {
    // Covers `sudo`, `sudoedit`, `sudoreplay`, and other sudo-family
    // entrypoints that cross the privilege boundary.
    id: "sudo",
    regex: /\bsudo\w*\b/,
    category: "privilege-escalation",
    severity: "medium",
    message: "sudo (or sudoedit/sudoreplay) executes with elevated privileges",
    commandPrefixes: ["sudo", "sudoedit", "sudoreplay"],
  },
  {
    // Bare `su` is still a privilege-boundary crossing (interactive
    // switch to root). Match any invocation regardless of args,
    // since the command head is already scoped to `su` by
    // commandPrefixes.
    id: "su",
    regex: /\bsu\b/,
    category: "privilege-escalation",
    severity: "medium",
    message: "su switches to another user account",
    commandPrefixes: ["su"],
  },
  {
    id: "chmod-setuid",
    regex: /\bchmod\b[^#\n]*(?:\+[a-rt-z]*s|\b[2-7][0-7]{3}\b)/,
    category: "privilege-escalation",
    severity: "high",
    message: "chmod with setuid/setgid bit enables privilege escalation",
    commandPrefixes: ["chmod"],
  },
  {
    id: "chmod-777-system",
    regex: new RegExp(
      `\\bchmod\\b[^\\n#]*\\s-[a-zA-Z]*R[a-zA-Z]*\\s+[0-7]*777[0-7]*\\s+${SYSTEM_TARGET}`,
    ),
    category: "privilege-escalation",
    severity: "high",
    message: "chmod -R 777 on root or a system directory is a catastrophic permission change",
    commandPrefixes: ["chmod"],
  },
  {
    id: "chown-root",
    regex: /\bchown\b[^#\n]*\b(?:root\b|0:0)/,
    category: "privilege-escalation",
    severity: "medium",
    message: "chown root reassigns ownership to the root user",
    commandPrefixes: ["chown"],
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
