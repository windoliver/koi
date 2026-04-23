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
 */
const SYSTEM_PATH_TARGETS =
  "\\/(?:$|\\s|\\*|etc\\b|usr\\b|bin\\b|boot\\b|dev\\b|lib(?:32|64)?\\b|sbin\\b|var\\b|opt\\b|root\\b|srv\\b|home\\b|Users\\b|System\\b|Library\\b|Applications\\b|private\\b)|~(?:$|\\s)|\\$(?:\\{HOME\\}|HOME\\b)";

/** Bounded wildcard span — caps backtrack state to prevent regex-DoS. */
const B = "[^\\n#]{0,512}";

// Anchor to start-of-string or whitespace so `dist/*`, `foo/etc`, etc. don't
// trip the `/<sys-dir>` alternatives embedded mid-token.
const SYSTEM_PATH_REGEX = new RegExp(`(?:^|\\s)(?:${SYSTEM_PATH_TARGETS})`);

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
  if (!SYSTEM_PATH_REGEX.test(cmd)) return { ok: true };
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
  if (!SYSTEM_PATH_REGEX.test(cmd)) return { ok: true };
  return {
    ok: false,
    reason: "chmod -R 777 on the root or a system directory is a catastrophic permission change",
    pattern: "chmod+recursive+777+system-path",
    category: "destructive",
  };
}

/**
 * Git destructive operations. Subcommand + force-flag presence are checked
 * with independent linear regexes rather than a single greedy pattern so
 * inputs with many repeated subcommand words cannot force V8 backtracking.
 * Does NOT defeat quote-splitting obfuscation (`git reset --ha""rd`) — that
 * requires shell tokenization; see @koi/bash-ast for the AST-based classifier.
 */
function checkDestructiveGit(cmd: string): ClassificationResult {
  if (!/\bgit\b/.test(cmd)) return { ok: true };

  if (/\breset\b/.test(cmd) && /--hard\b/.test(cmd)) {
    return {
      ok: false,
      reason: "git reset --hard discards uncommitted changes without confirmation",
      pattern: "git+reset+--hard",
      category: "destructive",
    };
  }
  if (/\bpush\b/.test(cmd) && /(?:--force(?:-with-lease)?\b|\s-[a-zA-Z]*f\b)/.test(cmd)) {
    return {
      ok: false,
      reason: "git push --force rewrites remote history and can erase teammates' work",
      pattern: "git+push+force",
      category: "destructive",
    };
  }
  if (/\bclean\b/.test(cmd) && /(?:--force\b|\s-[a-zA-Z]*f)/.test(cmd)) {
    return {
      ok: false,
      reason: "git clean -f permanently deletes untracked files",
      pattern: "git+clean+force",
      category: "destructive",
    };
  }
  if (
    /\bbranch\b/.test(cmd) &&
    /(?:\s-[a-zA-Z]*D\b|--delete\b[\s\S]{0,200}--force\b|--force\b[\s\S]{0,200}--delete\b)/.test(
      cmd,
    )
  ) {
    return {
      ok: false,
      reason: "git branch -D force-deletes a branch and can lose unmerged commits",
      pattern: "git+branch+force-delete",
      category: "destructive",
    };
  }
  if (/\bcheckout\b/.test(cmd) && /(?:--force\b|\s-[a-zA-Z]*f\b)/.test(cmd)) {
    return {
      ok: false,
      reason: "git checkout -f discards uncommitted changes in the working tree",
      pattern: "git+checkout+force",
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
    // dd if=... of=/dev/<disk> — raw block-device write destroys the target disk
    regex: new RegExp(`\\bdd\\b${B}\\bof=\\/dev\\/`),
    category: "destructive",
    reason: "dd writing to a /dev/ block device destroys all data on the target disk",
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
  {
    // find -exec rm / -execdir rm — destructive chain that bypasses rm's -rf system-path guard
    regex: new RegExp(`\\bfind\\b${B}-exec(?:dir)?\\b${B}\\brm\\b`),
    category: "destructive",
    reason: "find -exec rm deletes matched files without per-file confirmation",
  },
  {
    // find -delete — in-tree destructive deletion
    regex: new RegExp(`\\bfind\\b${B}-delete\\b`),
    category: "destructive",
    reason: "find -delete removes matched files in-place",
  },
  {
    // xargs ... rm — delete-everything-from-stdin chain
    regex: new RegExp(`\\bxargs\\b${B}\\brm\\b`),
    category: "destructive",
    reason: "xargs rm deletes files fed from stdin with no confirmation",
  },
] as const;

/**
 * Extended persistence patterns — SSH directory writes via expansion forms
 * that the literal `authorized_keys` substring check misses.
 */
const SSH_DIR_WRITE: ThreatPattern = {
  // Write-redirect (`>`, `>>`, `>|` noclobber-override, `&>` stderr+stdout,
  // optional fd prefix like `3>`) or a file-write verb (tee/cp/mv/install),
  // then an optional opening quote, then a target under ~/.ssh, $HOME/.ssh,
  // or ${HOME}/.ssh. Matches: `> ~/.ssh/x`, `exec 3> "$HOME/.ssh/x"`,
  // `exec 3>|$HOME/.ssh/x`, `cp key ~/.ssh/id_rsa`.
  regex: new RegExp(
    `(?:\\d*(?:>>?\\|?|&>)\\s*["']?|\\b(?:tee|cp|mv|install)\\b${B}\\s["']?)(?:~|\\$HOME|\\$\\{HOME\\})\\/\\.ssh\\/`,
  ),
  category: "persistence",
  reason: "Writing into ~/.ssh establishes persistent SSH access",
};

/** All classifier patterns ordered by threat severity (destructive first). */
const ALL_CLASSIFIER_PATTERNS: readonly ThreatPattern[] = [
  ...DESTRUCTIVE_PATTERNS,
  ...REVERSE_SHELL_PATTERNS,
  ...PRIVILEGE_PATTERNS,
  ...PERSISTENCE_PATTERNS,
  SSH_DIR_WRITE,
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
  const rmResult = checkDestructiveRm(normalized);
  if (!rmResult.ok) return rmResult;
  const chmodResult = checkDestructiveChmod(normalized);
  if (!chmodResult.ok) return chmodResult;
  const gitResult = checkDestructiveGit(normalized);
  if (!gitResult.ok) return gitResult;
  return matchPatterns(normalized, ALL_CLASSIFIER_PATTERNS);
}
