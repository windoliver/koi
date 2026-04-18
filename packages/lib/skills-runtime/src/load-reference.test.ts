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
import { loadReference } from "./load-reference.js";

describe("loadReference — Tier 2 file loading", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-ref-"));
    await Bun.write(join(root, "my-skill", "SKILL.md"), "---\nname: my-skill\n---\n");
    await Bun.write(join(root, "my-skill", "references", "rules.md"), "reference content");
    await Bun.write(
      join(root, "my-skill", "scripts", "nested", "run.sh"),
      "#!/bin/bash\necho hi\n",
    );
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
    const result = await loadReference("my-skill", dir, "scripts/nested/run.sh");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain("echo hi");
  });

  test("rejects parent-directory escape with PATH_TRAVERSAL", async () => {
    const dir = join(root, "my-skill");
    const result = await loadReference("my-skill", dir, "../sibling-secret");
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
    const sibling = join(root, "sibling", "secret.txt");
    await writeFile(sibling, "sibling data", { flag: "w" }).catch(async () => {
      await Bun.write(sibling, "sibling data");
    });
    // Symlink inside the skill dir pointing outside it.
    await symlink(sibling, join(dir, "references", "escape.txt"));

    const result = await loadReference("my-skill", dir, "references/escape.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.context).toMatchObject({ errorKind: "PATH_TRAVERSAL" });
    }
  });
});
