import { MAX_INPUT_LENGTH, matchPatterns, normalizeForMatch } from "./match.js";
import type { ClassificationResult, ThreatPattern } from "./types.js";

/**
 * Reverse-shell / lateral-movement patterns — compiled once at module load.
 * Covers /dev/tcp, socat, ncat, and curl/wget-pipe-shell.
 */
const REVERSE_SHELL_PATTERNS: readonly ThreatPattern[] = [
  {
    regex: /\/dev\/tcp\//,
    category: "reverse-shell",
    reason: "/dev/tcp enables raw TCP socket connections for reverse shells",
  },
  {
    regex: /\/dev\/udp\//,
    category: "reverse-shell",
    reason: "/dev/udp enables raw UDP socket connections",
  },
  {
    regex: /\bsocat\b/,
    category: "reverse-shell",
    reason: "socat is a common reverse shell and port-forwarding tool",
  },
  {
    // ncat, nc with listen/execute flags (nc alone is too broad)
    regex: /\bncat\b|\bnc\b\s+.*-[elp]/,
    category: "reverse-shell",
    reason: "netcat/ncat with listen/execute flags is a reverse shell vector",
  },
  {
    regex: /\bcurl\b[^|#\n]*\|\s*(ba)?sh\b/,
    category: "reverse-shell",
    reason: "curl-pipe-shell executes remotely fetched code",
  },
  {
    regex: /\bwget\b[^|#\n]*\|\s*(ba)?sh\b/,
    category: "reverse-shell",
    reason: "wget-pipe-shell executes remotely fetched code",
  },
  {
    // Python reverse shell: python -c "import socket; ..."
    regex: /\bpython[23]?\b[^#\n]*\bsocket\b[^#\n]*\bconnect\b/,
    category: "reverse-shell",
    reason: "Python socket.connect() is a common reverse shell pattern",
  },
] as const;

/**
 * Privilege escalation patterns.
 */
const PRIVILEGE_PATTERNS: readonly ThreatPattern[] = [
  {
    regex: /\bsudo\b/,
    category: "privilege-escalation",
    reason: "sudo can execute commands with elevated privileges",
  },
  {
    // `su` followed by a username or flag — not matching `sum`, `sub`, etc.
    regex: /\bsu\s/,
    category: "privilege-escalation",
    reason: "su switches to another user account",
  },
  {
    // chmod with setuid/setgid bit: chmod +s, chmod a+s, chmod 4755, etc.
    regex: /\bchmod\b[^#\n]*(([+][^-\s]*s)|([0-7]*[2-6][0-9]{3}\b))/,
    category: "privilege-escalation",
    reason: "chmod with setuid/setgid bit enables privilege escalation",
  },
  {
    regex: /\/etc\/passwd/,
    category: "privilege-escalation",
    reason: "Accessing /etc/passwd can reveal or modify user accounts",
  },
  {
    regex: /\/etc\/shadow/,
    category: "privilege-escalation",
    reason: "Accessing /etc/shadow exposes password hashes",
  },
] as const;

/**
 * Persistence installation patterns.
 */
const PERSISTENCE_PATTERNS: readonly ThreatPattern[] = [
  {
    regex: /\bcrontab\b[^#\n]*-[eli]/,
    category: "persistence",
    reason: "crontab modification can install persistent scheduled tasks",
  },
  {
    regex: /authorized_keys/,
    category: "persistence",
    reason: "Modifying authorized_keys establishes persistent SSH access",
  },
  {
    regex: /\/etc\/cron/,
    category: "persistence",
    reason: "Writing to /etc/cron directories can install persistent tasks",
  },
  {
    regex: /\bsystemctl\b[^#\n]*\benable\b/,
    category: "persistence",
    reason: "systemctl enable installs a persistent system service",
  },
] as const;

/**
 * Reconnaissance patterns.
 */
const RECON_PATTERNS: readonly ThreatPattern[] = [
  {
    regex: /\bwhoami\b/,
    category: "recon",
    reason: "whoami reveals the current user context",
  },
  {
    regex: /\buname\b[^#\n]*-a\b/,
    category: "recon",
    reason: "uname -a reveals kernel version and OS details",
  },
  {
    regex: /\/etc\/os-release/,
    category: "recon",
    reason: "Reading /etc/os-release reveals OS distribution details",
  },
  {
    regex: /\bnetstat\b/,
    category: "recon",
    reason: "netstat reveals active network connections and listening ports",
  },
] as const;

/**
 * Data-exfiltration patterns — outbound data transfer utilities.
 *
 * These block the most common paths for copying workspace data off-machine.
 * They complement (not replace) OS-level network isolation: an attacker who
 * can run arbitrary interpreters can always use library-level HTTP/socket APIs
 * that are not caught by regex.  Use `wrapCommand` with network-isolated
 * sandboxing for full egress control.
 */
const EXFILTRATION_PATTERNS: readonly ThreatPattern[] = [
  {
    // scp copies files to/from remote hosts — direct exfiltration path
    regex: /\bscp\b/,
    category: "data-exfiltration",
    reason: "scp can copy workspace files to remote systems",
  },
  {
    // sftp — interactive or batch file transfer over SSH
    regex: /\bsftp\b/,
    category: "data-exfiltration",
    reason: "sftp can transfer files to remote systems",
  },
  {
    // ftp — plaintext file transfer
    regex: /\bftp\b/,
    category: "data-exfiltration",
    reason: "ftp can transfer files to remote systems",
  },
  {
    // rsync with remote path notation: user@host:path or ::module
    regex: /\brsync\b[^#\n]*(\w+@[\w.-]+:|::[\w-]+)/,
    category: "data-exfiltration",
    reason: "rsync to a remote path can copy workspace data off-machine",
  },
  {
    // ssh with a remote host — can execute commands or open tunnels.
    // Lookbehind excludes `.ssh/` path references and word-continuations but
    // NOT `/` so path-invoked executables like `/usr/bin/ssh user@host` still
    // match. Lookahead excludes hyphen-suffixed local tools (`ssh-keygen`,
    // `ssh-add`, `ssh-copy-id`) and word chars.
    regex: /(?<![\w.-])ssh(?![-\w])/,
    category: "data-exfiltration",
    reason: "ssh can execute remote commands or tunnel data out-of-band",
  },
  {
    // lftp — an enhanced FTP/SFTP/HTTP client, common exfil tool
    regex: /\blftp\b/,
    category: "data-exfiltration",
    reason: "lftp can transfer files to remote FTP/SFTP/HTTP endpoints",
  },
  {
    // tftp — trivial FTP, often used in firmware/staging exfil
    regex: /\btftp\b/,
    category: "data-exfiltration",
    reason: "tftp can transfer files to remote TFTP endpoints",
  },
  {
    // curl file upload: -T / --upload-file
    regex: /\bcurl\b[^#\n]*(-T\b|--upload-file\b)/,
    category: "data-exfiltration",
    reason: "curl --upload-file/-T transmits files to a remote server",
  },
  {
    // curl POST/form data: -d, --data*, -F, --form*
    regex:
      /\bcurl\b[^#\n]*(-d\b|--data\b|--data-binary\b|--data-raw\b|--data-urlencode\b|-F\b|--form\b|--form-string\b)/,
    category: "data-exfiltration",
    reason: "curl with data/form flags can POST file contents to a remote server",
  },
  {
    // wget POST: --post-data, --post-file, or explicit --method=POST
    regex: /\bwget\b[^#\n]*(--post-data\b|--post-file\b|--method[= ]POST)/,
    category: "data-exfiltration",
    reason: "wget with POST flags can send data to a remote server",
  },
] as const;

/**
 * Catastrophically destructive patterns — unrecoverable data loss or host
 * takedown. These block even after a user approves the Bash call, because
 * "approve Bash once" should not be license to run `rm -rf /`.
 *
 * Scope: system-path `rm -rf`, filesystem format, block-device writes, fork
 * bombs, chmod-777 on root, system shutdown. `rm -rf /tmp/x` and other
 * workspace-scoped destructive ops are intentionally NOT caught here — the
 * user's approval remains the authority for workspace-scoped operations.
 */
/**
 * System-path target alternation shared by rm/chmod destructive patterns.
 * Linux, macOS, and common top-level directories. `/tmp` is intentionally
 * omitted so workspace-scoped operations stay allowed.
 *
 * Alternatives (after path-simplification in simplifyPathTokens):
 *   - `/` followed by end/space/star or a system top-level name
 *   - `~` end/space/`/` — so `~`, `~ `, `~/`, `~/.ssh` all match
 *   - `$HOME` / `${HOME}` references
 */
const SYSTEM_PATH_TARGETS =
  "\\/(?:$|\\s|\\*|etc\\b|usr\\b|bin\\b|boot\\b|dev\\b|lib(?:32|64)?\\b|sbin\\b|var\\b|opt\\b|root\\b|srv\\b|home\\b|Users\\b|System\\b|Library\\b|Applications\\b|private\\b)|~(?:$|\\s|\\/)|\\$(?:\\{HOME\\}|HOME\\b)";

// Anchor to start-of-string or whitespace so `dist/*`, `foo/etc`, etc. don't
// trip the `/<sys-dir>` alternatives embedded mid-token. Case-insensitive so
// macOS paths mounted on case-insensitive volumes (`/users`, `/system`,
// `/library`, `/applications`) match the same system trees as their canonical
// capitalized forms.
const SYSTEM_PATH_REGEX = new RegExp(`(?:^|\\s)(?:${SYSTEM_PATH_TARGETS})`, "i");

/**
 * Normalize path-like fragments so bash-equivalent forms collapse to a shape
 * SYSTEM_PATH_REGEX can match. Bash resolves `/./etc`, `//etc`, and
 * `/./././etc` all to `/etc`, so an attacker cannot hide a system target
 * behind redundant `.` or `/` segments.
 */
function simplifyPathTokens(cmd: string): string {
  // Collapse runs of `/` and `/./` sequences. Repeat until fixed-point, bounded
  // to a handful of iterations so adversarial input cannot loop.
  let out = cmd;
  for (let iter = 0; iter < 8; iter++) {
    const next = out.replace(/\/(?:\.\/)+/g, "/").replace(/\/\/+/g, "/");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * rm with BOTH a recursive-flag and a force-flag (in any order, grouped or
 * split) targeting a system path is the destructive case. Using three separate
 * linear-time regex tests avoids the combinatorial-backtrack space that a
 * monolithic regex would produce on adversarial input, and handles `rm -r -f`,
 * `rm -f -r`, `rm --recursive -f`, `rm -f --recursive`, etc.
 */
function checkDestructiveRm(cmd: string): ClassificationResult {
  if (!/\brm\b/.test(cmd)) return { ok: true };
  const hasRecursive = /(?:\s-[a-zA-Z]*[rR][a-zA-Z]*|\s--recursive\b)/.test(cmd);
  const hasForce = /(?:\s-[a-zA-Z]*[fF][a-zA-Z]*|\s--force\b)/.test(cmd);
  if (!hasRecursive || !hasForce) return { ok: true };
  const simplified = simplifyPathTokens(cmd);
  if (!SYSTEM_PATH_REGEX.test(simplified)) return { ok: true };
  return {
    ok: false,
    reason: "rm -rf targeting the root, a system directory, or the home directory is unrecoverable",
    pattern: "rm+recursive+force+system-path",
    category: "destructive",
  };
}

function checkDestructiveChmod(cmd: string): ClassificationResult {
  if (!/\bchmod\b/.test(cmd)) return { ok: true };
  const hasRecursive = /(?:\s-[a-zA-Z]*R[a-zA-Z]*|\s--recursive\b)/.test(cmd);
  const has777 = /\b[0-7]*777[0-7]*\b/.test(cmd);
  if (!hasRecursive || !has777) return { ok: true };
  const simplified = simplifyPathTokens(cmd);
  if (!SYSTEM_PATH_REGEX.test(simplified)) return { ok: true };
  return {
    ok: false,
    reason: "chmod -R 777 on the root or a system directory is a catastrophic permission change",
    pattern: "chmod+recursive+777+system-path",
    category: "destructive",
  };
}

/**
 * Top-level git options that consume the next token as their value when
 * written in space-separated form (e.g. `git -c foo=bar push ...`,
 * `git -C /tmp push ...`). `--long=value` forms are always single tokens.
 */
const GIT_OPTS_WITH_VALUE = new Set([
  "-c",
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
]);

interface GitInvocation {
  readonly preOptions: readonly string[];
  readonly subcommand: string;
  readonly args: readonly string[];
}

/**
 * Extract a git invocation's subcommand and arg tokens from a normalized
 * command string. Handles top-level options that take a value correctly so
 *   git -c color.ui=false push --force origin main
 *   git -C /tmp push --force
 * identify `push` as the subcommand rather than the option value.
 */
function extractGitSubcommand(cmd: string): GitInvocation | null {
  const tokens = cmd.split(/\s+/).filter((t) => t.length > 0);
  const gitIdx = tokens.findIndex((t) => t === "git" || /\/git$/.test(t));
  if (gitIdx === -1) return null;
  const preOptions: string[] = [];
  let i = gitIdx + 1;
  while (i < tokens.length) {
    const tok = tokens[i] ?? "";
    if (tok === "") {
      i++;
      continue;
    }
    if (tok.startsWith("--") && tok.includes("=")) {
      preOptions.push(tok);
      i++;
      continue;
    }
    if (GIT_OPTS_WITH_VALUE.has(tok)) {
      preOptions.push(tok, tokens[i + 1] ?? "");
      i += 2;
      continue;
    }
    if (tok.startsWith("-")) {
      preOptions.push(tok);
      i++;
      continue;
    }
    return { preOptions, subcommand: tok, args: tokens.slice(i + 1) };
  }
  return null;
}

/**
 * Config keys that let an attacker smuggle force-destructive behavior through
 * a scoped git subcommand:
 *   - `alias.<name>` redefines `<name>` to any command ("push --force", "!sh").
 *   - `include.path` / `includeIf.*.path` loads an external config file that
 *     can itself define aliases, yielding the same bypass one level removed.
 *
 * Matching is case-insensitive because git normalizes config keys internally:
 * `ALIAS.PU` is equivalent to `alias.pu`.
 *
 * Rejected in every channel git reads: `-c`, `--config`, `--config-env`, the
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*` env series, and
 * `GIT_CONFIG_PARAMETERS`.
 */
function isDangerousConfigKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower.startsWith("alias.")) return true;
  if (lower === "include.path") return true;
  if (/^includeif\..*\.path$/.test(lower)) return true;
  return false;
}

/**
 * Reject git config override injection through every channel git accepts:
 *   - `-c <key>=<value>` invocation-time config
 *   - `--config=<key>=<value>`
 *   - `--config-env=<key>=ENVVAR`
 * Without this guard, an attacker can define a force-capable alias
 *   git -c alias.pu='push --force' pu origin main
 * or load an attacker-controlled config file
 *   git -c include.path=/tmp/evil.cfg fp origin main
 * and bypass every scoped push/clean/branch/checkout check because git
 * resolves the alias/include internally before the subcommand runs.
 */
function gitHasAliasOverride(preOptions: readonly string[]): boolean {
  for (let i = 0; i < preOptions.length; i++) {
    const tok = preOptions[i];
    if (tok === "-c") {
      const keyPart = (preOptions[i + 1] ?? "").split("=")[0] ?? "";
      if (isDangerousConfigKey(keyPart)) return true;
    }
    if (tok?.startsWith("--config=")) {
      const keyPart = tok.slice("--config=".length).split("=")[0] ?? "";
      if (isDangerousConfigKey(keyPart)) return true;
    }
    if (tok?.startsWith("--config-env=")) {
      const keyPart = tok.slice("--config-env=".length).split("=")[0] ?? "";
      if (isDangerousConfigKey(keyPart)) return true;
    }
  }
  return false;
}

/**
 * Git also resolves aliases and includes from environment variables set on
 * the SAME command line as the `git` invocation. Two channels:
 *   - `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`/`GIT_CONFIG_VALUE_*` — structured
 *   - `GIT_CONFIG_PARAMETERS` — serialized single-variable form
 * Detect either before the `git` token so the attacker cannot smuggle an
 * alias or `include.path` through the process environment.
 *
 * Matching is case-insensitive to mirror git's own config-key normalization.
 */
function hasGitConfigEnvAliasInjection(cmd: string): boolean {
  // Structured channel: GIT_CONFIG_COUNT=N GIT_CONFIG_KEY_i=... ...
  // Git parses the count through strtol, so `01`, `+1`, `0x1`, and leading
  // whitespace forms all work. Fail closed whenever *any* GIT_CONFIG_KEY_*
  // carries a dangerous config key — independent of the count value, which
  // can also be set earlier in the same process environment.
  if (/\bGIT_CONFIG_KEY_\d+\s*=\s*alias\./i.test(cmd)) return true;
  if (/\bGIT_CONFIG_KEY_\d+\s*=\s*include\.path\b/i.test(cmd)) return true;
  if (/\bGIT_CONFIG_KEY_\d+\s*=\s*includeIf\./i.test(cmd)) return true;
  // Serialized channel: GIT_CONFIG_PARAMETERS="'alias.pu=!git push --force'"
  // Values are quoted and comma/space separated; each contains a key=value.
  if (/\bGIT_CONFIG_PARAMETERS\s*=/.test(cmd)) {
    if (/\balias\./i.test(cmd) || /\binclude\.path\b/i.test(cmd) || /\bincludeIf\./i.test(cmd)) {
      return true;
    }
  }
  return false;
}

/** Does an argv token match a force-flag in any short-bundle or long form? */
function hasForceFlag(args: readonly string[]): boolean {
  for (const tok of args) {
    if (tok === "--force" || tok === "--force-with-lease") return true;
    if (/^--force-/.test(tok)) return true;
    if (/^-[A-Za-z]*f[A-Za-z]*$/.test(tok)) return true;
  }
  return false;
}

/** Does an argv token match a `branch -d`/`-D` form (force or short)? */
function hasBranchDeleteFlag(args: readonly string[]): boolean {
  for (const tok of args) {
    if (tok === "--delete") return true;
    if (/^-[A-Za-z]*[dD][A-Za-z]*$/.test(tok)) return true;
  }
  return false;
}

/** Does an argv token match a force-delete short form? */
function hasBranchForceDeleteShort(args: readonly string[]): boolean {
  return args.some((tok) => /^-[A-Za-z]*D[A-Za-z]*$/.test(tok));
}

/**
 * Check a single git invocation's subcommand + args for destructive forms.
 * Helper used by the multi-segment scanner below.
 */
function checkGitInvocation(
  preOptions: readonly string[],
  subcommand: string,
  args: readonly string[],
): ClassificationResult {
  if (gitHasAliasOverride(preOptions)) {
    return {
      ok: false,
      reason:
        "git alias or include.path override at invocation time (-c / --config / --config-env) can smuggle force-push or other destructive subcommands past scoped checks",
      pattern: "git+config-override",
      category: "destructive",
    };
  }

  if (subcommand === "reset" && args.some((t) => t === "--hard")) {
    return {
      ok: false,
      reason: "git reset --hard discards uncommitted changes without confirmation",
      pattern: "git+reset+--hard",
      category: "destructive",
    };
  }
  if (subcommand === "push") {
    const hasForceRefspec = args.some((t) => /^\+[\w/.:-]+/.test(t));
    const hasDeleteFlag = args.some((t) => t === "--delete" || /^-[A-Za-z]*d[A-Za-z]*$/.test(t));
    const hasDeleteRefspec = args.some((t) => /^:[\w/.-]+/.test(t));
    const hasMirror = args.some((t) => t === "--mirror");
    const hasPrune = args.some((t) => t === "--prune");
    if (
      hasForceFlag(args) ||
      hasForceRefspec ||
      hasDeleteFlag ||
      hasDeleteRefspec ||
      hasMirror ||
      hasPrune
    ) {
      return {
        ok: false,
        reason:
          "git push --force / +refspec / --delete / :<ref> deletion / --mirror / --prune can rewrite or remove remote refs",
        pattern: "git+push+destructive",
        category: "destructive",
      };
    }
  }
  if (subcommand === "clean" && hasForceFlag(args)) {
    return {
      ok: false,
      reason: "git clean -f permanently deletes untracked files",
      pattern: "git+clean+force",
      category: "destructive",
    };
  }
  if (subcommand === "branch") {
    if (hasBranchForceDeleteShort(args) || (hasBranchDeleteFlag(args) && hasForceFlag(args))) {
      return {
        ok: false,
        reason: "git branch -D force-deletes a branch and can lose unmerged commits",
        pattern: "git+branch+force-delete",
        category: "destructive",
      };
    }
  }
  if (subcommand === "checkout" && hasForceFlag(args)) {
    return {
      ok: false,
      reason: "git checkout -f discards uncommitted changes in the working tree",
      pattern: "git+checkout+force",
      category: "destructive",
    };
  }
  return { ok: true };
}

/**
 * Split a normalized command on shell segment separators so each simple
 * command can be analyzed independently. Splitting avoids the prior bug where
 * `git status | git push --force` or `git log; git reset --hard` analyzed
 * only the first git invocation and missed the destructive second one.
 */
function splitShellSegments(cmd: string): string[] {
  return cmd
    .split(/\|\||&&|[;|&\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Builtins that set variables when used as a command prefix. `export a=x`,
 * `declare -g a=x`, `typeset a=x`, `readonly a=x`, `local a=x` all bind
 * `a=x` in the shell. Without this, an attacker prefixes with `export` and
 * the assignment resolver misses the binding:
 *     export target=/etc; rm -rf "$target"
 */
const ASSIGNMENT_BUILTIN_PREFIX = /^(?:export|declare|readonly|typeset|local)(?:\s+-\S+)*\s+/;

/**
 * Resolve simple `VAR=VALUE` assignments within the command before pattern
 * matching. Destructive classifiers compare literal tokens (e.g. `--force`,
 * `/etc`), so an attacker can hide dangerous inputs in a prior assignment:
 *
 *     target=/etc; rm -rf "$target"          → rm -rf /etc
 *     export target=/etc; rm -rf "$target"   → rm -rf /etc
 *     force=--force; git push $force origin  → git push --force origin
 *     f=f; rm -r$f /etc                      → rm -rf /etc
 *
 * Scope is intentionally narrow: only `NAME=VALUE` at the start of a segment,
 * optionally prefixed by one of the assignment-builtin keywords. VALUEs that
 * themselves contain `$` are NOT re-expanded, so an attacker cannot use
 * `a=$a$a` to blow up the output size beyond MAX_INPUT_LENGTH.
 *
 * The total output is bounded to MAX_INPUT_LENGTH; if substitution would
 * exceed that, we abort and return a length-capped string that the downstream
 * length guard will reject.
 */
function resolveSimpleAssignments(cmd: string): string {
  // Preserve the segment separators by splitting with a capturing group.
  const parts = cmd.split(/(\|\||&&|[;|&\n])/);
  const vars = new Map<string, string>();
  const out: string[] = [];
  const assignment = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)=(\S*)(\s+|$)/;
  let totalBytes = 0;
  for (const part of parts) {
    if (/^(?:\|\||&&|[;|&\n])$/.test(part)) {
      out.push(part);
      totalBytes += part.length;
      continue;
    }
    let segment = part;
    // Strip a single leading assignment-builtin keyword (export/declare/etc.)
    // so the next pass sees `NAME=VALUE ...` and records it as an assignment.
    const builtinMatch = segment.match(ASSIGNMENT_BUILTIN_PREFIX);
    if (builtinMatch !== null) {
      segment = segment.slice(builtinMatch[0].length);
    }
    // Consume any number of leading VAR=VALUE assignments.
    while (true) {
      const m = segment.match(assignment);
      if (!m) break;
      const name = m[2] ?? "";
      const value = m[3] ?? "";
      vars.set(name, value);
      segment = segment.slice((m[0] ?? "").length);
    }
    if (vars.size > 0) {
      // Substitute longest names first so $VAR1 is not eaten by $VAR.
      const names = [...vars.keys()].sort((a, b) => b.length - a.length);
      for (const name of names) {
        const value = vars.get(name) ?? "";
        // Ambiguity guard: an empty captured value can mean either a truly
        // empty assignment (`s=`) or a quoted-whitespace assignment
        // (`s=' '`) whose separator was word-split away by the normalizer.
        // In the latter case, bash word-splitting would produce tokens that
        // our regex checks cannot see (e.g. `rm${s}-rf${s}/etc` → `rm -rf
        // /etc`). Leave such expansions unresolved so downstream
        // checkDestructiveArgvExpansion fails closed on embedded `$name`
        // adjacent to destructive commands.
        if (value === "") continue;
        segment = segment.replace(new RegExp(`\\$\\{${name}\\}`, "g"), value);
        segment = segment.replace(new RegExp(`\\$${name}(?![A-Za-z0-9_])`, "g"), value);
        if (segment.length > MAX_INPUT_LENGTH) {
          // Stop expanding on blow-up. Downstream length guard will reject.
          segment = segment.slice(0, MAX_INPUT_LENGTH + 1);
          break;
        }
      }
    }
    out.push(segment);
    totalBytes += segment.length;
    if (totalBytes > MAX_INPUT_LENGTH) {
      // Bail out with an over-length prefix; the classifier's length guard
      // will reject it and the regex scans will never run on the blown-up
      // payload.
      return out.join("").slice(0, MAX_INPUT_LENGTH + 1);
    }
  }
  return out.join("");
}

/**
 * Destructive argv that still contains an unresolved parameter/command
 * substitution is unsafe: the classifier cannot verify the expansion does not
 * add a force flag or swap the target to a system path. Reject when any of
 * these subcommands appears alongside a `$` or backtick expansion in the
 * same segment.
 */
const EXPANSION_TOKEN = /\$(?:[A-Za-z_{(]|[0-9@*#?$!-])|`/;
const DESTRUCTIVE_COMMANDS = /\b(?:rm|chmod|chown|dd|mkfs(?:\.\w+)?|shred|git|find|xargs)\b/;

function checkDestructiveArgvExpansion(resolved: string): ClassificationResult {
  for (const segment of splitShellSegments(resolved)) {
    if (!DESTRUCTIVE_COMMANDS.test(segment)) continue;
    if (!EXPANSION_TOKEN.test(segment)) continue;
    return {
      ok: false,
      reason:
        "Destructive command (rm/chmod/chown/dd/mkfs/shred/git/find/xargs) with an unresolved parameter or command substitution cannot be safely classified; set VAR=VALUE before the command or use a literal argument",
      pattern: "destructive+unresolved-expansion",
      category: "injection",
    };
  }
  return { ok: true };
}

/**
 * Git destructive operations. The command is split into shell segments and
 * every git invocation across the pipeline is analyzed. Env-var channels
 * that can smuggle aliases (`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*`) are
 * rejected whenever they appear alongside a git invocation.
 *
 * The caller passes the pre-resolved (post-normalization, pre-assignment-
 * substitution) command so that `GIT_CONFIG_COUNT=N ...` prefixes are still
 * visible here — the assignment resolver otherwise consumes them.
 */
function checkDestructiveGit(preResolved: string, resolved: string): ClassificationResult {
  if (hasGitConfigEnvAliasInjection(preResolved) && /\bgit\b/.test(preResolved)) {
    return {
      ok: false,
      reason:
        "GIT_CONFIG_COUNT / GIT_CONFIG_KEY_* env channels can inject aliases or include.path overrides that bypass scoped destructive checks",
      pattern: "git+env-config-injection",
      category: "destructive",
    };
  }
  for (const segment of splitShellSegments(resolved)) {
    const parsed = extractGitSubcommand(segment);
    if (parsed === null) continue;
    const result = checkGitInvocation(parsed.preOptions, parsed.subcommand, parsed.args);
    if (!result.ok) return result;
  }
  return { ok: true };
}

/**
 * Flag any segment whose first token starts with `$` (variable expansion) or
 * `` ` `` (legacy command substitution). These command-position expansions
 * hide the actual command from any regex-based classifier: an attacker can
 * do `a=r; b=m; $a$b -rf /etc` and bash will execute `rm -rf /etc` after
 * classification has already approved the input.
 *
 * Known false-positive: `$HOME/bin/tool` and `$EDITOR file.txt` are flagged.
 * Agents writing commands through this gate should use explicit paths rather
 * than env-var indirection. Callers that need variable-as-command support
 * must resolve the expansion before calling the classifier.
 */
function checkCommandPositionExpansion(cmd: string): ClassificationResult {
  for (const segment of splitShellSegments(cmd)) {
    const firstTok = segment.split(/\s+/)[0] ?? "";
    if (/^\$[\w({]/.test(firstTok) || firstTok.startsWith("`")) {
      return {
        ok: false,
        reason:
          "Command-position variable or command substitution hides the real command from classification; use an explicit command literal instead",
        pattern: "expansion-at-command-position",
        category: "injection",
      };
    }
  }
  return { ok: true };
}

/**
 * Destructive command-pair checks: run as independent linear presence probes
 * across the whole validated input, not as bounded-span regexes. A bounded
 * gap becomes a padding bypass under the 8KB input limit.
 */
function checkDestructiveCommandPairs(cmd: string): ClassificationResult {
  if (/\bdd\b/.test(cmd) && /\bof=\/dev\//.test(cmd)) {
    return {
      ok: false,
      reason: "dd writing to a /dev/ block device destroys all data on the target disk",
      pattern: "dd+of=/dev",
      category: "destructive",
    };
  }
  if (/\bfind\b/.test(cmd) && /-exec(?:dir)?\b/.test(cmd) && /\brm\b/.test(cmd)) {
    return {
      ok: false,
      reason: "find -exec rm deletes matched files without per-file confirmation",
      pattern: "find+-exec+rm",
      category: "destructive",
    };
  }
  if (/\bfind\b/.test(cmd) && /-delete\b/.test(cmd)) {
    return {
      ok: false,
      reason: "find -delete removes matched files in-place",
      pattern: "find+-delete",
      category: "destructive",
    };
  }
  if (/\bxargs\b/.test(cmd) && /\brm\b/.test(cmd)) {
    return {
      ok: false,
      reason: "xargs rm deletes files fed from stdin with no confirmation",
      pattern: "xargs+rm",
      category: "destructive",
    };
  }
  return { ok: true };
}

const DESTRUCTIVE_PATTERNS: readonly ThreatPattern[] = [
  {
    // mkfs, mkfs.ext4, mke2fs, mkswap — reformat a filesystem (destroys all data)
    regex: /\b(?:mkfs(?:\.\w+)?|mke2fs|mkswap)\b/,
    category: "destructive",
    reason: "mkfs/mkswap formats a filesystem and destroys all data on the device",
  },
  {
    // Classic fork bomb: :(){:|:&};:  (whitespace-tolerant)
    regex: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
    category: "destructive",
    reason: "fork bomb exhausts process slots and wedges the host",
  },
  {
    // shutdown / reboot / halt / poweroff — takes the host offline
    regex: /\b(?:shutdown|reboot|halt|poweroff)\b/,
    category: "destructive",
    reason: "shutdown/reboot/halt/poweroff takes the host offline",
  },
  {
    // init 0 (halt) and init 6 (reboot)
    regex: /\binit\s+[06]\b/,
    category: "destructive",
    reason: "init 0/6 halts or reboots the host",
  },
] as const;

/**
 * Extended persistence patterns — SSH directory writes via expansion forms
 * that the literal `authorized_keys` substring check misses.
 *
 * Detects a write-redirect (`>`, `>>`, `>|`, `&>`, `>&`, optional fd prefix)
 * followed by a `~/.ssh/` or `$HOME/.ssh/` target. This is kept as a regex
 * because redirects are always adjacent to their target, so there is no
 * padding-bypass surface.
 */
const SSH_DIR_WRITE_REDIRECT: ThreatPattern = {
  regex: /\d*(?:>>?\|?|&>|>&)\s*(?:~|\$HOME|\$\{HOME\})\/\.ssh\//,
  category: "persistence",
  reason: "Writing into ~/.ssh establishes persistent SSH access",
};

/**
 * Detect write-verb (`tee`, `cp`, `mv`, `install`) targeting `~/.ssh/...` by
 * token-scanning the argv of each segment, not by regex with a bounded span
 * between verb and target. An attacker can pad the argv with many operands
 * to push the target past a bounded-span regex; an argv scan is linear in
 * the token count and has no such blind spot.
 */
const SSH_DIR_WRITE_VERBS = new Set(["tee", "cp", "mv", "install"]);
const SSH_DIR_TARGET = /^(?:~|\$HOME|\$\{HOME\})\/\.ssh\//;

function checkSshDirWriteVerb(cmd: string): ClassificationResult {
  for (const segment of splitShellSegments(cmd)) {
    const tokens = segment.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length === 0) continue;
    const hasVerb = tokens.some((t) => SSH_DIR_WRITE_VERBS.has(t));
    if (!hasVerb) continue;
    if (tokens.some((t) => SSH_DIR_TARGET.test(t))) {
      return {
        ok: false,
        reason: "Writing into ~/.ssh establishes persistent SSH access",
        pattern: "ssh-dir-write-verb",
        category: "persistence",
      };
    }
  }
  return { ok: true };
}

/** All classifier patterns ordered by threat severity (destructive first). */
const ALL_CLASSIFIER_PATTERNS: readonly ThreatPattern[] = [
  ...DESTRUCTIVE_PATTERNS,
  ...REVERSE_SHELL_PATTERNS,
  ...PRIVILEGE_PATTERNS,
  ...PERSISTENCE_PATTERNS,
  SSH_DIR_WRITE_REDIRECT,
  ...RECON_PATTERNS,
  ...EXFILTRATION_PATTERNS,
] as const;

/**
 * Classify a bash command string against known dangerous TTP patterns.
 *
 * Pattern sets cover MITRE ATT&CK categories: reverse shells, privilege
 * escalation, persistence, and reconnaissance. Complex destructive patterns
 * (rm, chmod, git) run as token-based linear-time checks to avoid regex-DoS
 * and catch split-flag bypasses that a single regex cannot handle.
 *
 * Returns the first matched threat with full diagnostic context.
 */
export function classifyCommand(command: string): ClassificationResult {
  if (command.length > MAX_INPUT_LENGTH) {
    return {
      ok: false,
      reason: `Input exceeds ${MAX_INPUT_LENGTH} chars; reject to avoid regex-DoS`,
      pattern: `length:${command.length}`,
      category: "injection",
    };
  }
  const normalized = normalizeForMatch(command);
  // Resolve simple `VAR=VALUE; CMD $VAR` assignments so literal checks like
  // "does args contain --force" and "does the command touch /etc" see the
  // expanded form rather than a symbolic `$VAR`. Substitution is bounded by
  // MAX_INPUT_LENGTH inside the resolver; re-check here because an attacker
  // can craft a sub-limit input that expands beyond the cap.
  const resolved = resolveSimpleAssignments(normalized);
  if (resolved.length > MAX_INPUT_LENGTH) {
    return {
      ok: false,
      reason: `Variable expansion produced more than ${MAX_INPUT_LENGTH} chars; reject to avoid regex-DoS`,
      pattern: `resolved-length:${resolved.length}`,
      category: "injection",
    };
  }
  const expansionResult = checkCommandPositionExpansion(resolved);
  if (!expansionResult.ok) return expansionResult;
  const rmResult = checkDestructiveRm(resolved);
  if (!rmResult.ok) return rmResult;
  const chmodResult = checkDestructiveChmod(resolved);
  if (!chmodResult.ok) return chmodResult;
  const gitResult = checkDestructiveGit(normalized, resolved);
  if (!gitResult.ok) return gitResult;
  const argExpansionResult = checkDestructiveArgvExpansion(resolved);
  if (!argExpansionResult.ok) return argExpansionResult;
  const sshVerbResult = checkSshDirWriteVerb(resolved);
  if (!sshVerbResult.ok) return sshVerbResult;
  const pairResult = checkDestructiveCommandPairs(resolved);
  if (!pairResult.ok) return pairResult;
  return matchPatterns(resolved, ALL_CLASSIFIER_PATTERNS);
}
