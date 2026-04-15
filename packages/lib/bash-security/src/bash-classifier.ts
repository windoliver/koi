import { matchPatterns } from "./match.js";
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
    // ssh with a remote host — can execute commands or open tunnels
    regex: /\bssh\b/,
    category: "data-exfiltration",
    reason: "ssh can execute remote commands or tunnel data out-of-band",
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
const DESTRUCTIVE_PATTERNS: readonly ThreatPattern[] = [
  {
    // rm with both -r and -f (any order, any flag grouping) targeting bare root,
    // a system top-level dir, `~`, or `$HOME`. Catches `rm -rf /`, `rm -Rf /etc`,
    // `rm -fr /var`, `rm --recursive --force ~`.
    // Matches `/`, `/*`, or `/<system_dir>` at a word boundary; whitespace or
    // end-of-string terminates the target. Workspace-scoped paths like
    // `/tmp/foo` intentionally do not match (they hit `/tmp` which is not listed).
    regex:
      /\brm\b[^\n#]*\s(?:--recursive\s+--force|--force\s+--recursive|-[a-zA-Z]*(?:[rR][a-zA-Z]*[fF]|[fF][a-zA-Z]*[rR])[a-zA-Z]*)[^\n#]*?\s(?:\/(?:$|\s|\*|etc\b|usr\b|bin\b|boot\b|dev\b|lib(?:32|64)?\b|sbin\b|var\b|opt\b|root\b|srv\b|home\b)|~(?:$|\s)|\$HOME\b)/,
    category: "destructive",
    reason: "rm -rf targeting the root, a system directory, or the home directory is unrecoverable",
  },
  {
    // mkfs, mkfs.ext4, mke2fs, mkswap — reformat a filesystem (destroys all data)
    regex: /\b(?:mkfs(?:\.\w+)?|mke2fs|mkswap)\b/,
    category: "destructive",
    reason: "mkfs/mkswap formats a filesystem and destroys all data on the device",
  },
  {
    // dd if=... of=/dev/<disk> — raw block-device write destroys the target disk
    regex: /\bdd\b[^\n#]*\bof=\/dev\//,
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
    // chmod -R 777 on root, a system dir, `~`, or `$HOME`. Mirrors the rm -rf
    // target set — catastrophic permission change across the system.
    regex:
      /\bchmod\b[^\n#]*\s-[a-zA-Z]*R[a-zA-Z]*\s+[0-7]*777[0-7]*\s+(?:\/(?:$|\s|\*|etc\b|usr\b|bin\b|boot\b|dev\b|lib(?:32|64)?\b|sbin\b|var\b|opt\b|root\b|srv\b|home\b)|~(?:$|\s)|\$HOME\b)/,
    category: "destructive",
    reason: "chmod -R 777 on the root or a system directory is a catastrophic permission change",
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

/** All classifier patterns ordered by threat severity (destructive first). */
const ALL_CLASSIFIER_PATTERNS: readonly ThreatPattern[] = [
  ...DESTRUCTIVE_PATTERNS,
  ...REVERSE_SHELL_PATTERNS,
  ...PRIVILEGE_PATTERNS,
  ...PERSISTENCE_PATTERNS,
  ...RECON_PATTERNS,
  ...EXFILTRATION_PATTERNS,
] as const;

/**
 * Classify a bash command string against known dangerous TTP patterns.
 *
 * Pattern sets cover MITRE ATT&CK categories: reverse shells, privilege
 * escalation, persistence, and reconnaissance.
 *
 * Returns the first matched threat with full diagnostic context.
 */
export function classifyCommand(command: string): ClassificationResult {
  return matchPatterns(command, ALL_CLASSIFIER_PATTERNS);
}
