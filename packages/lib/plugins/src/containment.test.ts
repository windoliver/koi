import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertContained } from "./containment.js";

describe("assertContained", () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `koi-containment-test-${Date.now()}`);
    await mkdir(join(root, "skills", "greeting"), { recursive: true });
    await writeFile(join(root, "skills", "greeting", "SKILL.md"), "# Greeting");
    await writeFile(join(root, "hooks.json"), "{}");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("valid relative path within root resolves successfully", async () => {
    const result = await assertContained("./skills/greeting", root);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain("skills/greeting");
    }
  });

  test("valid file path within root resolves successfully", async () => {
    const result = await assertContained("./hooks.json", root);
    expect(result.ok).toBe(true);
  });

  test("path traversal rejected — ../../../etc", async () => {
    const result = await assertContained("../../../etc/passwd", root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("nonexistent path returns PERMISSION error", async () => {
    const result = await assertContained("./does-not-exist", root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });

  test("symlink escape rejected", async () => {
    // Create a symlink that escapes the root
    const outsideDir = join(tmpdir(), `koi-outside-${Date.now()}`);
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "secret.txt"), "secret");

    const linkPath = join(root, "escape-link");
    await symlink(outsideDir, linkPath);

    const result = await assertContained("./escape-link/secret.txt", root);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
      expect(result.error.message).toContain("escapes plugin root");
    }

    await rm(outsideDir, { recursive: true, force: true });
  });
});
